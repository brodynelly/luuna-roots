// `luuna-roots guard`: the Claude Code PreToolUse hook (roots-ecaa; human/agent
// boundary guard 3). Pure decision logic; commands/guard.ts does the I/O.
//
// Input: the hook JSON on stdin ({tool_name, tool_input, cwd, ...}).
//   Write | Edit | MultiEdit   tool_input.file_path
//   NotebookEdit               tool_input.notebook_path
//   Bash                       tool_input.command (best effort, see below)
// A file target is denied when it lies under any `.luuna/roots/human/` directory:
// relative paths resolve against the hook's cwd, `..` is normalized, and
// symlinks are followed (a link anywhere on the path, including a dangling
// final link, whose target is under .luuna/roots/human/). The check does not need a
// roots project: any path with `.luuna/roots/human` in it is protected. The
// comparison ignores case, since macOS filesystems do.
//
// Bash is best effort. The command is split into segments on ; && || | and
// newlines, and a segment is denied when it mentions `.luuna/roots/human` and
//   - redirects output (>, >>, &>) to a path under .luuna/roots/human/, or
//   - runs rm/rmdir/mv/touch/truncate/chmod/chown/unlink/shred/mkdir/tee on it, or
//   - runs cp/ln/install/rsync with the last argument under it, or
//   - runs sed/perl with -i (in place), dd with of=..., or git
//     checkout/restore/rm/mv/apply on it.
// A shell can always evade this (cd first, variables, eval, scripts). The
// The threat model (SECURITY.md) is accidental mixing, not a malicious actor.
//
// Unparsable input fails OPEN (allow, note on stderr): a broken hook must not
// block every tool call in the session, and the other guards (no agent code
// path writes human/, the verify hash ledger) still catch mistakes.

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { realOrSelf } from "./boundary.ts";

export const FILE_TOOLS: Record<string, string> = {
	Write: "file_path",
	Edit: "file_path",
	MultiEdit: "file_path",
	NotebookEdit: "notebook_path",
};

export interface GuardDecision {
	decision: "allow" | "deny";
	reason?: string;
	/** The path or command that was checked. */
	target?: string;
}

export interface HookInput {
	tool_name?: unknown;
	tool_input?: unknown;
	cwd?: unknown;
}

const HUMAN_SEGMENT = /(^|[\\/])(?:\.luuna[\\/]+roots|\.roots)[\\/]+human([\\/]|$)/i;

/** True when an absolute, normalized path has a `.luuna/roots/human` component pair. */
export function lexicallyHuman(abs: string): boolean {
	return HUMAN_SEGMENT.test(abs.split(sep).join("/"));
}

function isLink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Where a write to `p` would land: symlinks followed (including a dangling
 * final link), and the deepest existing ancestor realpath'd.
 */
export function resolveWriteTarget(p: string): string {
	let cur = resolve(p);
	for (let hops = 0; hops < 40 && isLink(cur); hops++) {
		const link = readlinkSync(cur);
		cur = isAbsolute(link) ? resolve(link) : resolve(dirname(cur), link);
	}
	const tail: string[] = [];
	let probe = cur;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) return cur;
		tail.unshift(probe.slice(parent.length).replace(/^[\\/]/, ""));
		probe = parent;
	}
	return resolve(realOrSelf(probe), ...tail);
}

/** True when writing `p` (relative to `cwd`) would touch a `.luuna/roots/human/` tree. */
export function isProtectedPath(p: string, cwd: string): boolean {
	const abs = resolve(cwd, p);
	return lexicallyHuman(abs) || lexicallyHuman(resolveWriteTarget(abs));
}

// ── Bash (best effort) ────────────────────────────────────────────────────

const REMOVE_OR_TOUCH = new Set([
	"rm",
	"rmdir",
	"mv",
	"touch",
	"truncate",
	"chmod",
	"chown",
	"unlink",
	"shred",
	"mkdir",
	"tee",
]);
const COPY_TO_LAST = new Set(["cp", "ln", "install", "rsync"]);
const GIT_WRITES = new Set(["checkout", "restore", "rm", "mv", "apply"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "xargs"]);

function unquote(t: string): string {
	return t.replace(/^['"]|['"]$/g, "");
}

function mentionsHuman(s: string, cwd: string): boolean {
	const t = unquote(s);
	return t !== "" && (/(?:\.luuna[\\/]+roots|\.roots)[\\/]+human/i.test(t) || isProtectedPath(t, cwd));
}

function commandWords(segment: string): string[] {
	const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
	while (words.length > 0) {
		const w = words[0] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) words.shift();
		else break;
	}
	return words;
}

function redirectsIntoHuman(segment: string, cwd: string): boolean {
	const re = /(?:^|[^0-9<])(?:&?>>?|[0-9]>>?)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g;
	for (const m of segment.matchAll(re)) {
		const target = m[1] ?? "";
		if (target !== "" && !target.startsWith("&") && mentionsHuman(target, cwd)) return true;
	}
	return false;
}

function segmentWrites(segment: string, cwd: string): boolean {
	if (redirectsIntoHuman(segment, cwd)) return true;
	const [cmd = "", ...args] = commandWords(segment);
	const name = cmd.split("/").pop() ?? cmd;
	const paths = args.filter((a) => !a.startsWith("-"));
	const anyHuman = paths.some((a) => mentionsHuman(a, cwd));
	if (REMOVE_OR_TOUCH.has(name)) return anyHuman;
	if (COPY_TO_LAST.has(name)) return mentionsHuman(paths[paths.length - 1] ?? "", cwd);
	if (name === "sed" || name === "perl") {
		return anyHuman && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
	}
	if (name === "dd") return args.some((a) => a.startsWith("of=") && mentionsHuman(a.slice(3), cwd));
	if (name === "git") return GIT_WRITES.has(paths[0] ?? "") && anyHuman;
	return false;
}

/** Best-effort: does this shell command look like it writes under .luuna/roots/human/? */
export function bashWritesHuman(command: string, cwd: string): boolean {
	if (!/(?:\.luuna[\\/]+roots|\.roots)[\\/]+human/i.test(command)) return false;
	return command.split(/\n|;|&&|\|\||\|/).some((seg) => segmentWrites(seg, cwd));
}

// ── Decision ──────────────────────────────────────────────────────────────

export const DENY_REASON =
	"roots: .luuna/roots/human/ holds human-written intent; agents never edit it. " +
	"Ask a question with `luuna-roots ask`, propose with `luuna-roots propose`/`luuna-roots sprout`, " +
	"or attach material with `luuna-roots note`.";

function field(obj: unknown, key: string): unknown {
	return typeof obj === "object" && obj !== null
		? (obj as Record<string, unknown>)[key]
		: undefined;
}

export function decideHook(input: HookInput, fallbackCwd: string): GuardDecision {
	const tool = typeof input.tool_name === "string" ? input.tool_name : "";
	const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : fallbackCwd;
	const key = FILE_TOOLS[tool];
	if (key) {
		const p = field(input.tool_input, key);
		if (typeof p !== "string" || p === "") return { decision: "allow" };
		return isProtectedPath(p, cwd)
			? { decision: "deny", reason: `${DENY_REASON} (blocked ${tool} on ${p})`, target: p }
			: { decision: "allow", target: p };
	}
	if (tool === "Bash") {
		const cmd = field(input.tool_input, "command");
		if (typeof cmd !== "string") return { decision: "allow" };
		return bashWritesHuman(cmd, cwd)
			? { decision: "deny", reason: `${DENY_REASON} (blocked a shell write)`, target: cmd }
			: { decision: "allow", target: cmd };
	}
	return { decision: "allow" };
}

/** Claude Code PreToolUse JSON output for a denial. */
export function denyOutput(reason: string): string {
	return `${JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	})}\n`;
}
