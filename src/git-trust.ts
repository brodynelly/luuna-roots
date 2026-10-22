// Git probes for `luuna-roots verify`'s hash ledger (roots-ecaa; guard 4): an idea.md
// whose content differs from its last trusted hash is still fine when that
// content comes from a human-authored commit.
//
// A file "comes from a commit" when git tracks it and it has no working-tree
// or staged change. The commit that produced it is the last commit touching
// the path (`git log -1 -- <file>`).
//
// Agent commit detection (isAgentCommit), any of:
//   - author or committer email is noreply@anthropic.com, or contains "[bot]@"
//   - author or committer name ends in "[bot]", or is one of AGENT_NAMES
//     (claude, claude code, codex, copilot, devin, aider, sapling, warren)
//   - a Co-Authored-By trailer names such an identity (by name or email).
//     Claude Code adds "Co-Authored-By: Claude <noreply@anthropic.com>", so a
//     human commit that an agent co-wrote does NOT launder an edit: the
//     conservative reading of "human-authored".
// Names match whole, case-insensitively, so a human called "Claude Dupont"
// is not flagged by name alone.

import { spawnSync } from "node:child_process";
import { relative } from "node:path";

export interface CommitInfo {
	sha: string;
	authorName: string;
	authorEmail: string;
	committerName: string;
	committerEmail: string;
	message: string;
}

export type FileState = "clean" | "modified" | "untracked";

export interface GitProbe {
	/** False when git is missing or the project is not in a work tree. */
	available: boolean;
	fileState(abs: string): FileState;
	lastCommit(abs: string): CommitInfo | null;
}

export const AGENT_NAMES = [
	"claude",
	"claude code",
	"codex",
	"copilot",
	"devin",
	"aider",
	"sapling",
	"warren",
];

function agentName(name: string): boolean {
	const n = name.trim().toLowerCase();
	return n.endsWith("[bot]") || AGENT_NAMES.includes(n);
}

function agentEmail(email: string): boolean {
	const e = email.trim().toLowerCase();
	return e === "noreply@anthropic.com" || e.includes("[bot]@");
}

/** "Name <email>" → [name, email]. */
function splitIdent(s: string): [string, string] {
	const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(s.trim());
	return m ? [m[1] ?? "", m[2] ?? ""] : [s.trim(), ""];
}

/** Why this commit counts as agent-authored, or null for a human commit. */
export function isAgentCommit(c: CommitInfo): string | null {
	if (agentName(c.authorName) || agentEmail(c.authorEmail)) {
		return `authored by ${c.authorName} <${c.authorEmail}>`;
	}
	if (agentName(c.committerName) || agentEmail(c.committerEmail)) {
		return `committed by ${c.committerName} <${c.committerEmail}>`;
	}
	for (const m of c.message.matchAll(/^co-authored-by:\s*(.+)$/gim)) {
		const [name, email] = splitIdent(m[1] ?? "");
		if (agentName(name) || agentEmail(email)) return `co-authored by ${(m[1] ?? "").trim()}`;
	}
	return null;
}

function git(root: string, env: Record<string, string | undefined>, args: string[]) {
	try {
		const r = spawnSync("git", args, {
			cwd: root,
			env: env as NodeJS.ProcessEnv,
			encoding: "utf8",
		});
		return { ok: r.status === 0 && !r.error, out: r.stdout ?? "" };
	} catch {
		return { ok: false, out: "" };
	}
}

export function gitProbe(root: string, env: Record<string, string | undefined>): GitProbe {
	const inside = git(root, env, ["rev-parse", "--is-inside-work-tree"]);
	const available = inside.ok && inside.out.trim() === "true";
	const rel = (abs: string) => relative(root, abs) || ".";
	return {
		available,
		fileState(abs) {
			const tracked = git(root, env, ["ls-files", "--error-unmatch", "--", rel(abs)]).ok;
			if (!tracked) return "untracked";
			const status = git(root, env, ["status", "--porcelain=v1", "--", rel(abs)]);
			return status.ok && status.out.trim() === "" ? "clean" : "modified";
		},
		lastCommit(abs) {
			const fmt = "%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B";
			const r = git(root, env, ["log", "-1", `--format=${fmt}`, "--", rel(abs)]);
			if (!r.ok || r.out.trim() === "") return null;
			const [sha, authorName, authorEmail, committerName, committerEmail, message] =
				r.out.split("\0");
			return {
				sha: sha ?? "",
				authorName: authorName ?? "",
				authorEmail: authorEmail ?? "",
				committerName: committerName ?? "",
				committerEmail: committerEmail ?? "",
				message: message ?? "",
			};
		},
	};
}

/** A probe for "no git" (tests, or callers that skip git). */
export const NO_GIT: GitProbe = {
	available: false,
	fileState: () => "untracked",
	lastCommit: () => null,
};
