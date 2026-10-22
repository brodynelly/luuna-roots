// Shared test utilities: temp projects, in-process CLI runs, subprocess runs.
//
// In-process runs call runCli() with a captured Io, so they are fast and
// deterministic. Human commands need a TTY: in-process runs pass
// `stdinIsTTY` directly; subprocess runs use ROOTS_FORCE_TTY=1 + NODE_ENV=test
// (see src/guard.ts), which is honored only under test.

import { afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { stripAnsi } from "./color.ts";
import { loadConfig, type RootsConfig, writeConfig } from "./config.ts";
import { updateGraph } from "./graph.ts";
import type { Io } from "./io.ts";
import { rootsPaths } from "./paths.ts";
import { ESC, type Terminal } from "./terminal.ts";
import type { NodeStatus } from "./types.ts";

const created: string[] = [];

/** A fresh temp directory, removed after the current test. */
export function tempDir(prefix = "roots-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RunOptions {
	env?: Record<string, string | undefined>;
	/** Simulate an interactive stdin (default true). */
	tty?: boolean;
	/** Interactive terminal for `think` (see fakeTerminal). */
	terminal?: Terminal;
	/** Text on stdin (hook handlers such as `luuna-roots guard`). */
	stdin?: string;
}

export const BASE_ENV: Record<string, string | undefined> = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	NO_COLOR: "1",
	ROOTS_USER: "Test Human",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
};

export async function run(args: string[], cwd: string, opts: RunOptions = {}): Promise<RunResult> {
	let stdout = "";
	let stderr = "";
	const io: Io = {
		cwd,
		env: { ...BASE_ENV, ...opts.env },
		stdout: (t) => {
			stdout += t;
		},
		stderr: (t) => {
			stderr += t;
		},
		stdinIsTTY: opts.tty ?? true,
		stdoutIsTTY: false,
		terminal: opts.terminal,
		readStdin: async () => opts.stdin ?? "",
	};
	const exitCode = await runCli(args, io);
	return { stdout, stderr, exitCode };
}

/** Run with --json appended and parse stdout. */
export async function runJson<T = Record<string, unknown>>(
	args: string[],
	cwd: string,
	opts: RunOptions = {},
): Promise<{ exitCode: number; body: T; stderr: string }> {
	const r = await run([...args, "--json"], cwd, opts);
	return { exitCode: r.exitCode, body: JSON.parse(r.stdout) as T, stderr: r.stderr };
}

/** A temp dir with `luuna-roots init` already run. */
export async function initProject(): Promise<string> {
	const dir = tempDir();
	const r = await run(["init"], dir);
	if (r.exitCode !== 0) throw new Error(`init failed: ${r.stderr}`);
	return dir;
}

/** Plant an idea and return its id. */
export async function plant(cwd: string, statement: string, extra: string[] = []): Promise<string> {
	const { exitCode, body } = await runJson<{ id: string }>(["plant", statement, ...extra], cwd);
	if (exitCode !== 0) throw new Error(`plant failed: ${JSON.stringify(body)}`);
	return body.id;
}

/** Write an executable editor script that writes `content` into its argument. */
export function fakeEditor(dir: string, content: string): string {
	const script = join(dir, `editor-${Math.random().toString(16).slice(2)}.sh`);
	const payload = JSON.stringify(content).slice(1, -1).replace(/'/g, "'\\''");
	writeFileSync(script, `#!/bin/sh\nprintf '%b' '${payload}' > "$1"\n`);
	chmodSync(script, 0o755);
	return script;
}

export const CLI_ENTRY = join(import.meta.dir, "index.ts");

/** Spawn the real binary (for smoke tests). */
export async function spawnCli(
	args: string[],
	cwd: string,
	env: Record<string, string | undefined> = {},
	stdin?: string,
): Promise<RunResult> {
	const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
		cwd,
		stdin: stdin === undefined ? "ignore" : new Response(stdin),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...BASE_ENV, ...env } as Record<string, string>,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/** Poll until `cond` holds (default 3s timeout). */
export function waitFor(cond: () => boolean, ms = 3000, what = "condition"): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 5);
		};
		tick();
	});
}

export interface FakeTerminal extends Terminal {
	started: boolean;
	stopped: boolean;
	frames: string[];
	/** Deliver raw input as if typed. */
	send(data: string): void;
	/** Last frame drawn, ANSI stripped. */
	screen(): string;
}

/** An in-memory Terminal: records frames, injects keys. */
export function fakeTerminal(columns = 60, rows = 0): FakeTerminal {
	let onInput: ((d: string) => void) | null = null;
	const t: FakeTerminal = {
		started: false,
		stopped: false,
		frames: [],
		columns: () => columns,
		rows: () => rows,
		write(text) {
			if (text.startsWith(ESC.home)) t.frames.push(text);
		},
		start(cb) {
			t.started = true;
			onInput = cb;
		},
		stop() {
			t.stopped = true;
			onInput = null;
		},
		send(data) {
			onInput?.(data);
		},
		screen() {
			const last = t.frames[t.frames.length - 1] ?? "";
			return stripAnsi(last.slice(ESC.home.length + ESC.clear.length)).replace(/\r\n/g, "\n");
		},
	};
	return t;
}

/** Rewrite .luuna/roots/config.yaml with `patch` applied (e.g. a lower tier). */
export async function patchConfig(root: string, patch: Partial<RootsConfig>): Promise<void> {
	const paths = rootsPaths(root);
	await writeConfig(paths, { ...loadConfig(paths), ...patch });
}

/** Force a node's status in graph.jsonl (test setup only; bypasses lifecycle rules). */
export async function forceStatus(root: string, id: string, status: NodeStatus): Promise<void> {
	await updateGraph(rootsPaths(root), (g) => {
		const n = g.nodes.find((x) => x.id === id);
		if (n) n.status = status;
		return { write: true, result: null };
	});
}

/** Write <root>/.luuna/missions/issues.jsonl (`extra` is appended raw, e.g. a bad line). */
export function writeSeeds(root: string, rows: unknown[], extra = ""): void {
	mkdirSync(join(root, ".luuna/missions"), { recursive: true });
	const body = rows.map((r) => JSON.stringify(r)).join("\n");
	writeFileSync(join(root, ".luuna/missions", "issues.jsonl"), `${body}\n${extra}`);
}

/** Write <root>/.luuna/atlas/expertise/<domain>.jsonl. */
export function writeMulch(root: string, domain: string, rows: unknown[]): void {
	mkdirSync(join(root, ".luuna/atlas", "expertise"), { recursive: true });
	const body = rows.map((r) => JSON.stringify(r)).join("\n");
	writeFileSync(join(root, ".luuna/atlas", "expertise", `${domain}.jsonl`), `${body}\n`);
}

const GIT_ENV = {
	...BASE_ENV,
	GIT_AUTHOR_NAME: "Test Human",
	GIT_AUTHOR_EMAIL: "human@example.com",
	GIT_COMMITTER_NAME: "Test Human",
	GIT_COMMITTER_EMAIL: "human@example.com",
};

/** Run git in `root` (test setup); throws on failure. */
export function git(root: string, ...args: string[]): string {
	const r = spawnSync("git", args, {
		cwd: root,
		env: GIT_ENV as NodeJS.ProcessEnv,
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

/** `git init` + commit everything in `root`. */
export function gitInit(root: string): void {
	git(root, "init", "-q", "-b", "main");
	gitCommitAll(root, "initial");
}

export function gitCommitAll(root: string, message: string): void {
	git(root, "add", "-A");
	git(root, "commit", "-q", "--allow-empty", "-m", message);
}
