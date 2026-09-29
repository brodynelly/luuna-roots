// Launch the human's editor ($VISUAL, then $EDITOR, then vi) on a file.

import { spawnSync } from "node:child_process";
import { RootsError } from "./errors.ts";
import type { Io } from "./io.ts";

export function resolveEditor(env: Io["env"]): string {
	return env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
}

/**
 * Run the editor with an inherited terminal and wait for it to exit. The
 * editor string may contain arguments (e.g. "code -w"), so it runs via sh.
 */
export function openEditor(file: string, io: Pick<Io, "cwd" | "env">): void {
	const editor = resolveEditor(io.env);
	const r = spawnSync("sh", ["-c", `${editor} "$1"`, "roots-editor", file], {
		cwd: io.cwd,
		env: io.env as NodeJS.ProcessEnv,
		stdio: "inherit",
	});
	if (r.error) throw new RootsError(`could not start editor "${editor}": ${r.error.message}`);
	if (r.status !== 0) throw new RootsError(`editor "${editor}" exited with status ${r.status}`);
}

/**
 * Reference text below this line is removed on save (like git's commit
 * scissors), so the human can read an agent's text while writing their own.
 */
export const SCISSORS = "# ------------------------ >8 ------------------------";

/** Editor buffer: an empty area for the human, then the scissors and the reference. */
export function referenceBuffer(reference: readonly string[]): string {
	const hint = "# Everything from the line above down is removed when you save.";
	return `${["", "", SCISSORS, hint, ...reference].join("\n")}\n`;
}

/** Drop the scissors line and everything after it. Returns "" when nothing is left. */
export function stripReference(text: string): string {
	const lines = text.split(/\r?\n/);
	const cut = lines.findIndex((l) => l.trimEnd() === SCISSORS);
	if (cut === -1) return text;
	const kept = lines.slice(0, cut).join("\n").trimEnd();
	return kept === "" ? "" : `${kept}\n`;
}
