// Security tests for the human/agent boundary (roots-ecaa;
// AGENTS.md invariant 1): no agent command writes under
// .luuna/roots/human/, whatever the input — path traversal, absolute paths,
// symlinks planted in the agent tree, or hostile names.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { agentWriteExclusive, assertAgentWritable, isHumanPath } from "./boundary.ts";
import { EXIT, GuardError } from "./errors.ts";
import { rootsPaths } from "./paths.ts";
import { initProject, plant, run, runJson, tempDir } from "./test-helpers.ts";

const AGENT = ["--as", "agent:opus"];

/** Every path + content hash (or link target) under a directory. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = lstatSync(p);
			const key = relative(dir, p);
			if (st.isSymbolicLink()) out[key] = `-> ${readlinkSync(p)}`;
			else if (st.isDirectory()) {
				out[`${key}/`] = "dir";
				walk(p);
			} else {
				out[key] = createHash("sha256").update(readFileSync(p)).digest("hex");
			}
		}
	};
	walk(dir);
	return out;
}

async function setup() {
	const root = await initProject();
	const a = await plant(root, "Sync works offline and nobody loses work");
	const b = await plant(root, "The server is always authoritative");
	return { root, a, b, paths: rootsPaths(root) };
}

describe("assertAgentWritable", () => {
	test("only inside .luuna/roots/agent/, never human/, no traversal", async () => {
		const { paths } = await setup();
		const ok = join(paths.notes, "a1b2", "x.md");
		expect(() => assertAgentWritable(paths, ok)).not.toThrow();
		const bad = [
			join(paths.human, "x.md"),
			join(paths.notes, "..", "..", "human", "x.md"),
			join(paths.agent, "..", "graph.jsonl"),
			paths.agent,
			"/etc/passwd",
			join(paths.root, "README.md"),
		];
		for (const p of bad) expect(() => assertAgentWritable(paths, p)).toThrow(GuardError);
	});

	test("refuses symlinks anywhere in the agent tree", async () => {
		const { paths } = await setup();
		mkdirSync(paths.notes, { recursive: true });
		symlinkSync(paths.human, join(paths.notes, "a1b2"));
		expect(() => assertAgentWritable(paths, join(paths.notes, "a1b2", "x.md"))).toThrow(/symlink/);
		const outside = tempDir();
		symlinkSync(outside, join(paths.notes, "c3d4"));
		expect(() => agentWriteExclusive(paths, join(paths.notes, "c3d4", "x.md"), "x")).toThrow(
			GuardError,
		);
		expect(readdirSync(outside)).toEqual([]);
	});

	test("refuses when .luuna/roots/agent itself is a symlink into human/", async () => {
		const { paths } = await setup();
		const target = join(paths.human, "evil");
		mkdirSync(target);
		rmSync(paths.agent, { recursive: true, force: true });
		symlinkSync(target, paths.agent);
		expect(() =>
			agentWriteExclusive(paths, join(paths.sprouts, "a1b2-x", "sprout.md"), "x"),
		).toThrow(GuardError);
		expect(readdirSync(target)).toEqual([]);
	});

	test("exclusive create: never overwrites, never follows a final symlink", async () => {
		const { paths } = await setup();
		const dir = join(paths.notes, "a1b2");
		mkdirSync(dir, { recursive: true });
		const victim = join(paths.human, "victim.md");
		writeFileSync(victim, "human words\n");
		symlinkSync(victim, join(dir, "link.md"));
		expect(() => agentWriteExclusive(paths, join(dir, "link.md"), "agent words")).toThrow();
		expect(readFileSync(victim, "utf8")).toBe("human words\n");
	});

	test("isHumanPath: lexical and through symlinks", async () => {
		const { paths } = await setup();
		expect(isHumanPath(paths, ".luuna/roots/human/a1b2-x/idea.md")).toBe(true);
		expect(isHumanPath(paths, ".luuna/roots/agent/notes/a1b2/x.md")).toBe(false);
		mkdirSync(paths.agent, { recursive: true });
		symlinkSync(paths.human, join(paths.agent, "h"));
		expect(isHumanPath(paths, join(paths.agent, "h", "idea.md"))).toBe(true);
	});
});

describe("agent commands never write under .luuna/roots/human/", () => {
	test("ask, note, propose, sprout, context, prime with hostile input", async () => {
		const { root, a, b, paths } = await setup();
		const before = snapshot(paths.human);
		const src = join(root, "artifact.md");
		writeFileSync(src, "# research\n");
		const attempts: string[][] = [
			["ask", a, "What happens to a deleted record?", ...AGENT],
			["note", a, "--file", src, ...AGENT],
			["note", a, "--file", src, "--name", "../../human/idea.md", ...AGENT],
			["note", a, "--file", src, "--name", "/abs/../../human/x.md", ...AGENT],
			[
				"note",
				a,
				"--file",
				join(paths.human, readdirSync(paths.human)[0] ?? "", "idea.md"),
				...AGENT,
			],
			[
				"propose",
				"edge",
				a,
				b,
				"tension",
				"--reason",
				"r",
				"--cite",
				`${a}:Sync`,
				"--cite",
				`${b}:server`,
				...AGENT,
			],
			["sprout", "A new claim about sync", ...AGENT],
			["sprout", "../../human/evil", "--slug", "evil", ...AGENT],
			["sprout", "Another claim", "--slug", "../../human/x", ...AGENT],
			["sprout", "Human impersonation", "--as", "human:jay"],
			["context", a],
			["prime"],
		];
		for (const args of attempts) await run(args, root, { tty: false });
		expect(snapshot(paths.human)).toEqual(before);
	});

	test("a symlink planted in agent/ cannot redirect sprout or note writes into human/", async () => {
		const { root, a, paths } = await setup();
		const before = snapshot(paths.human);
		rmSync(paths.agent, { recursive: true, force: true });
		mkdirSync(paths.agent, { recursive: true });
		symlinkSync(paths.human, paths.sprouts);
		symlinkSync(paths.human, paths.notes);
		const src = join(root, "artifact.md");
		writeFileSync(src, "# research\n");
		const sprout = await runJson(["sprout", "Redirected claim", ...AGENT], root, { tty: false });
		expect(sprout.exitCode).toBe(EXIT.guard);
		const note = await runJson(["note", a, "--file", src, ...AGENT], root, { tty: false });
		expect(note.exitCode).toBe(EXIT.guard);
		expect(snapshot(paths.human)).toEqual(before);
	});

	test("agents cannot run human commands: plant, think, adopt need a TTY", async () => {
		const { root } = await setup();
		for (const cmd of [["plant", "x"], ["think"], ["adopt", "s-0000"]]) {
			const r = await run(cmd, root, { tty: false, env: { ROOTS_AGENT: "agent:opus" } });
			expect(r.exitCode).toBe(EXIT.guard);
		}
	});
});
