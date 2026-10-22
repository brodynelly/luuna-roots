// Open $EDITOR (or, for `luuna-roots adopt`, a pager on the sprout) in a split
// pane next to roots, when a terminal
// multiplexer is detectable. Detection: $TMUX (tmux), $ZELLIJ (zellij).
// Otherwise the human opens the file in another pane themselves; think
// prints the path.

import { spawnSync } from "node:child_process";
import { resolveEditor } from "./editor.ts";
import type { Io } from "./io.ts";

export type Multiplexer = "tmux" | "zellij";

export function detectMultiplexer(env: Io["env"]): Multiplexer | null {
	if (env.TMUX) return "tmux";
	if (env.ZELLIJ !== undefined && env.ZELLIJ !== "") return "zellij";
	return null;
}

export function shellQuote(s: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * argv that opens `editor file` in a new pane to the right (tmux/zellij).
 * `focus: false` keeps focus in the current pane where the multiplexer allows
 * it (tmux `-d`); zellij focuses the new pane regardless.
 */
export function splitArgv(
	mux: Multiplexer,
	editor: string,
	file: string,
	cwd: string,
	focus = true,
) {
	if (mux === "tmux") {
		const detach = focus ? [] : ["-d"];
		return ["tmux", "split-window", "-h", ...detach, "-c", cwd, `${editor} ${shellQuote(file)}`];
	}
	return [
		"zellij",
		"run",
		"--direction",
		"right",
		"--cwd",
		cwd,
		"--",
		"sh",
		"-c",
		`${editor} "$1"`,
		"roots-editor",
		file,
	];
}

export interface SpawnResult {
	status: number | null;
	stdout: string;
}

export type Spawner = (argv: string[], cwd: string) => SpawnResult;

export const realSpawner: Spawner = (argv, cwd) => {
	const [cmd = "", ...rest] = argv;
	const r = spawnSync(cmd, rest, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
};

export interface SplitLaunch {
	mux: Multiplexer | null;
	ok: boolean;
}

export interface SplitCommand {
	command: string;
	file: string;
	cwd: string;
	/** Move focus to the new pane (default true: the editor case). */
	focus?: boolean;
}

/** Open `command file` in a split pane when a multiplexer is detected. */
export function launchInSplit(
	env: Io["env"],
	cmd: SplitCommand,
	spawn: Spawner = realSpawner,
): SplitLaunch {
	const mux = detectMultiplexer(env);
	if (!mux) return { mux, ok: false };
	const focus = cmd.focus ?? true;
	const argv = splitArgv(mux, cmd.command, cmd.file, cmd.cwd, focus);
	return { mux, ok: spawn(argv, cmd.cwd).status === 0 };
}

/** Try to open the editor in a split. `file` is relative to `cwd`. */
export function launchEditorSplit(
	env: Io["env"],
	file: string,
	cwd: string,
	spawn: Spawner = realSpawner,
): SplitLaunch {
	return launchInSplit(env, { command: resolveEditor(env), file, cwd }, spawn);
}

/** Read-only pager for reference text (`luuna-roots adopt` shows the sprout this way). */
export function resolvePager(env: Io["env"]): string {
	return env.PAGER?.trim() || "less";
}

/** One-line hint for the think screen. */
export function editorHint(launch: SplitLaunch | null, file: string): string {
	if (launch?.ok) return `Editing ${file} in a ${launch.mux} pane. Save to answer.`;
	const failed = launch?.mux ? ` (could not open a ${launch.mux} split)` : "";
	return `Open ${file} in your editor in another pane${failed}. Save to answer.`;
}
