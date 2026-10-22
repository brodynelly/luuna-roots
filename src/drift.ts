// `luuna-roots drift`: which ideas a repo change touches (roots-4689: the
// tier-3 Stop hook `luuna-roots drift --diff HEAD`). Read-only
// and deterministic; no LLM. The agent reads the packet and may `luuna-roots ask`
// "does this still hold?". Nothing here writes.
//
// Changed files (gatherDrift): `git diff --name-only --relative <rev>` (the
// working tree + index against <rev>) plus untracked, non-ignored files
// (an agent's new file is as much a change as an edit), relative to the
// project root and limited to it. Files under .luuna/roots/, .luuna/missions/, .luuna/atlas/ and
// .luuna/beacon/ are left out: they are tool data, not the code ideas are about. Commit messages:
// `git log <rev>..HEAD` (empty for the default rev HEAD). Every git call has
// a timeout; any git failure yields `{ ok: false }`, never an exception.
//
// An idea is touched (matchDrift), for live ideas only (not composted, not
// sprouts), when:
//   slug    every word of its slug (≥ 3 chars, minus stop words) is a token
//           of a changed path: `offline-sync` ↔ src/sync/offline.ts
//   prose   its idea.md, or one of its text agent notes, mentions a changed
//           path (the full path, or a basename with an extension, ≥ 5 chars)
//   seeds   a seeds issue linked to it mentions a changed path the same way
//   commit  a commit message in <rev>..HEAD cites its r- id
// Then every live idea a touched idea serves (transitively) is added with
// reason `serves`: a change under an idea can bend the goal above it.
// Ideas whose effective tier is below 3 (a per-idea override) are left out:
// the override keeps agents away from them.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { RootsConfig } from "./config.ts";
import { citedIdeaIds } from "./idea-refs.ts";
import { listNotes } from "./notes.ts";
import type { RootsPaths } from "./paths.ts";
import { type NodeDirs, readNodeProse } from "./prose.ts";
import { issueLinks, type SeedsIssue } from "./seeds-link.ts";
import { servesAncestors } from "./serves-tree.ts";
import { effectiveTier } from "./tier.ts";
import type { Graph, NodeRecord } from "./types.ts";

export const DRIFT_TIER = 3;
export const MAX_FILES = 500;
export const MAX_COMMITS = 50;
const MAX_NOTE_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 5000;
const STOP_WORDS = new Set(["the", "and", "for", "not", "with", "from", "into", "its", "our"]);

// ── git ───────────────────────────────────────────────────────────────────

export interface DriftCommit {
	sha: string;
	subject: string;
	message: string;
}

export type DriftGit =
	| { ok: true; rev: string; files: string[]; truncated: boolean; commits: DriftCommit[] }
	| { ok: false; rev: string; reason: string };

type Env = Record<string, string | undefined>;

function git(root: string, env: Env, args: string[]): string | null {
	try {
		const r = spawnSync("git", args, {
			cwd: root,
			env: env as NodeJS.ProcessEnv,
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		return r.status === 0 && !r.error ? r.stdout : null;
	} catch {
		return null;
	}
}

function nulList(out: string): string[] {
	return out.split("\0").filter((s) => s !== "");
}

function parseCommits(out: string): DriftCommit[] {
	return out
		.split("\x1e")
		.map((chunk) => chunk.replace(/^\n+/, ""))
		.filter((chunk) => chunk.includes("\0"))
		.map((chunk) => {
			const [sha = "", message = ""] = chunk.split("\0");
			return { sha, subject: message.split("\n")[0] ?? "", message: message.trim() };
		});
}

const TOOL_DIRS = [".luuna", ".roots", ".seeds", ".mulch", ".canopy"];

/** os-eco tool data (.luuna/roots/, .luuna/missions/, .luuna/atlas/, .luuna/beacon/), not the code ideas are about. */
function isToolData(path: string): boolean {
	return TOOL_DIRS.some((d) => path === d || path.startsWith(`${d}/`));
}

/** Changed files and commit messages since `rev`. Never throws. */
export function gatherDrift(root: string, env: Env, rev: string): DriftGit {
	if (rev.startsWith("-") || rev.trim() === "") {
		return { ok: false, rev, reason: `invalid revision "${rev}"` };
	}
	if (git(root, env, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
		return { ok: false, rev, reason: "not a git work tree" };
	}
	if (git(root, env, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) === null) {
		return { ok: false, rev, reason: `unknown revision "${rev}"` };
	}
	const diff = git(root, env, ["diff", "--name-only", "--relative", "-z", rev, "--"]);
	const untracked = git(root, env, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (diff === null || untracked === null) return { ok: false, rev, reason: "git diff failed" };
	const all = [...new Set([...nulList(diff), ...nulList(untracked)])]
		.filter((f) => !isToolData(f))
		.sort();
	const fmt = "%h%x00%B%x1e";
	const log = git(root, env, ["log", `-n${MAX_COMMITS}`, `--format=${fmt}`, `${rev}..HEAD`, "--"]);
	return {
		ok: true,
		rev,
		files: all.slice(0, MAX_FILES),
		truncated: all.length > MAX_FILES,
		commits: log === null ? [] : parseCommits(log),
	};
}

// ── matching (pure) ───────────────────────────────────────────────────────

export type DriftReasonKind = "slug" | "prose" | "seeds" | "commit" | "serves";

export interface DriftReason {
	kind: DriftReasonKind;
	detail: string;
}

export interface DriftIdeaInput {
	node: NodeRecord;
	/** idea.md text plus any text agent notes (what `prose` matches against). */
	text: string;
}

export interface DriftMatchInput {
	graph: Graph;
	config: Pick<RootsConfig, "tier">;
	ideas: DriftIdeaInput[];
	files: readonly string[];
	commits: readonly DriftCommit[];
	issues: readonly SeedsIssue[];
}

export interface DriftHit {
	node: NodeRecord;
	reasons: DriftReason[];
}

export interface DriftMatch {
	touched: DriftHit[];
	/** Ideas left out by a per-idea tier override below 3. */
	excluded: string[];
}

function isLive(n: NodeRecord): boolean {
	return n.kind === "idea" && n.status !== "composted";
}

export function slugWords(slug: string): string[] {
	return slug.split("-").filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function pathTokens(path: string): Set<string> {
	return new Set(
		path
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	);
}

/** Does `text` mention `path` (full path, or a distinctive basename)? */
export function mentionsPath(text: string, path: string): boolean {
	if (text.includes(path)) return true;
	const base = basename(path);
	return base.length >= 5 && extname(base) !== "" && text.includes(base);
}

function slugReasons(node: NodeRecord, files: readonly string[]): DriftReason[] {
	const words = slugWords(node.slug);
	if (words.length === 0) return [];
	return files
		.filter((f) => {
			const tokens = pathTokens(f);
			return words.every((w) => tokens.has(w));
		})
		.map((f) => ({ kind: "slug", detail: `${f} matches the slug` }));
}

function proseReasons(text: string, files: readonly string[]): DriftReason[] {
	return files
		.filter((f) => mentionsPath(text, f))
		.map((f) => ({ kind: "prose", detail: `the idea or its notes mention ${f}` }));
}

function seedsReasons(
	node: NodeRecord,
	issues: readonly SeedsIssue[],
	files: readonly string[],
): DriftReason[] {
	const out: DriftReason[] = [];
	for (const issue of issues) {
		if (!issueLinks(issue).ids.includes(node.id)) continue;
		const text = `${issue.title}\n${typeof issue.description === "string" ? issue.description : ""}`;
		for (const f of files) {
			if (mentionsPath(text, f)) out.push({ kind: "seeds", detail: `${issue.id} mentions ${f}` });
		}
	}
	return out;
}

function commitReasons(node: NodeRecord, commits: readonly DriftCommit[]): DriftReason[] {
	return commits
		.filter((c) => citedIdeaIds(c.message).includes(node.id))
		.map((c) => ({ kind: "commit", detail: `${c.sha} ${c.subject}` }));
}

function directHits(input: DriftMatchInput): DriftHit[] {
	const hits: DriftHit[] = [];
	for (const { node, text } of input.ideas) {
		const reasons = [
			...commitReasons(node, input.commits),
			...slugReasons(node, input.files),
			...proseReasons(text, input.files),
			...seedsReasons(node, input.issues, input.files),
		];
		if (reasons.length > 0) hits.push({ node, reasons });
	}
	return hits;
}

function addAncestors(graph: Graph, hits: DriftHit[]): DriftHit[] {
	const byId = new Map(hits.map((h) => [h.node.id, h]));
	const extra = new Map<string, DriftHit>();
	for (const h of hits) {
		for (const up of servesAncestors(graph, h.node, isLive)) {
			if (byId.has(up.id)) continue;
			const hit = extra.get(up.id) ?? { node: up, reasons: [] };
			hit.reasons.push({ kind: "serves", detail: `${h.node.id} ${h.node.slug} serves it` });
			extra.set(up.id, hit);
		}
	}
	return [...hits, ...extra.values()];
}

/** Ideas the change touches, direct hits first (graph order), then what they serve. */
export function matchDrift(input: DriftMatchInput): DriftMatch {
	const all = addAncestors(input.graph, directHits(input));
	const allowed = (n: NodeRecord) => effectiveTier(input.config, n).tier >= DRIFT_TIER;
	return {
		touched: all.filter((h) => allowed(h.node)),
		excluded: all.filter((h) => !allowed(h.node)).map((h) => h.node.id),
	};
}

// ── reading ideas ─────────────────────────────────────────────────────────

function noteText(paths: RootsPaths, rel: string): string {
	const abs = join(paths.root, rel);
	if (![".md", ".txt"].includes(extname(abs)) || !existsSync(abs)) return "";
	try {
		return statSync(abs).size <= MAX_NOTE_BYTES ? readFileSync(abs, "utf8") : "";
	} catch {
		return "";
	}
}

/** Live ideas with their prose + text notes, for matchDrift. */
export function driftIdeas(paths: RootsPaths, graph: Graph, dirs: NodeDirs): DriftIdeaInput[] {
	return graph.nodes.filter(isLive).map((node) => {
		const prose = readNodeProse(paths, node, dirs).text;
		const notes = listNotes(paths, node).map((n) => noteText(paths, n.path));
		return { node, text: [prose, ...notes].join("\n") };
	});
}

/** idea.md path relative to the project root, for the packet. */
export function ideaFile(paths: RootsPaths, node: NodeRecord, dirs: NodeDirs): string | null {
	const p = readNodeProse(paths, node, dirs).path;
	return p ? relative(paths.root, p) : null;
}
