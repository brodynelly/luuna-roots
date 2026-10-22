// luuna-roots guard: Claude Code PreToolUse hook handler (installed by
// `luuna-roots setup claude`). Reads the hook JSON on stdin. Denies Write / Edit /
// MultiEdit / NotebookEdit under any .luuna/roots/human/, and (best effort) Bash
// commands that write there. See hook-guard.ts for the rules.
//
// Output follows Claude Code's PreToolUse contract: a denial prints
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
// "permissionDecisionReason":"..."}} on stdout and exits 0; an allow prints
// nothing and exits 0 (normal permission flow continues). Malformed input
// fails open with a note on stderr. --json prints the roots envelope instead
// (for debugging a hook by hand).

import { decideHook, denyOutput, type HookInput } from "../hook-guard.ts";
import type { CommandDef } from "../registry.ts";

function parseInput(raw: string): HookInput | null {
	try {
		const v: unknown = JSON.parse(raw);
		return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as HookInput) : null;
	} catch {
		return null;
	}
}

export const guardCommand: CommandDef = {
	name: "guard",
	group: "setup",
	summary: "PreToolUse hook: deny agent edits to .luuna/roots/human/ (reads hook JSON on stdin)",
	usage: "guard",
	description:
		"Claude Code PreToolUse hook handler. Reads {tool_name, tool_input, cwd} on stdin.\n" +
		"Denies Write/Edit/MultiEdit/NotebookEdit whose target resolves (relative paths, `..`,\n" +
		"symlinks) under any .luuna/roots/human/, and, best effort, Bash commands that write there.\n" +
		"Allows silently otherwise. Unparsable input is allowed with a note on stderr.",
	maxArgs: 0,
	async run({ io, out }) {
		const raw = io.stdinIsTTY || !io.readStdin ? "" : await io.readStdin();
		const input = parseInput(raw);
		if (!input) {
			io.stderr("luuna-roots guard: no hook JSON on stdin; allowing\n");
			await out.result({ decision: "allow", reason: "no hook input" });
			return;
		}
		const d = decideHook(input, io.cwd);
		await out.result({ ...d });
		if (out.json) return;
		if (d.decision === "deny") await io.stdout(denyOutput(d.reason ?? "denied by luuna-roots guard"));
	},
};
