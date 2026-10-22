// `luuna-roots verify` checks on disk: node directories, the .luuna/roots/human/ tree
// (stray files, symlinks), and the idea.md hash ledger (roots-ecaa; guard 4).
// Codes are documented in verify.ts.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isInside, realOrSelf } from "./boundary.ts";
import { isAgentCommit } from "./git-trust.ts";
import { hexOf } from "./ids.ts";
import { contentHash, dirCandidates, dirHex, dirNameFor, locateNodeDir } from "./prose.ts";
import type { EventRecord, NodeRecord } from "./types.ts";
import { issue, type VerifyCheck, type VerifyContext, type VerifyIssue } from "./verify-core.ts";

const IGNORED_NAMES = new Set([".DS_Store", ".gitkeep"]);

function lstat(p: string) {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}

function rel(ctx: VerifyContext, p: string): string {
	return relative(ctx.paths.root, p);
}

function label(n: NodeRecord): string {
	return `${n.id} ${n.slug}`;
}

// ── Node directories ──────────────────────────────────────────────────────

function nodeDirIssues(ctx: VerifyContext, n: NodeRecord): VerifyIssue[] {
	const names = dirCandidates(ctx.dirs, n);
	const dir = locateNodeDir(ctx.paths, n, ctx.dirs);
	if (dir === null) {
		return [
			issue("dir.missing", "error", `${n.kind} ${label(n)} has no directory (${dirNameFor(n)})`, {
				node: n.id,
			}),
		];
	}
	const out: VerifyIssue[] = [];
	if (names.length > 1) {
		out.push(
			issue(
				"dir.duplicate",
				"warning",
				`${label(n)} has ${names.length} directories: ${names.join(", ")}`,
				{
					node: n.id,
				},
			),
		);
	}
	const file = join(dir, n.kind === "idea" ? "idea.md" : "sprout.md");
	if (!existsSync(file)) {
		out.push(
			issue("dir.missing", "error", `${label(n)}: ${rel(ctx, file)} is missing`, {
				node: n.id,
				file: rel(ctx, file),
			}),
		);
	}
	return out;
}

function orphanDirs(
	ctx: VerifyContext,
	parent: string,
	kind: string,
	hexes: Set<string>,
): VerifyIssue[] {
	if (!existsSync(parent)) return [];
	const out: VerifyIssue[] = [];
	for (const name of readdirSync(parent).sort()) {
		if (IGNORED_NAMES.has(name)) continue;
		const hex = dirHex(name);
		if (hex !== null && hexes.has(hex)) continue;
		out.push(
			issue("dir.orphan", "warning", `${rel(ctx, join(parent, name))} matches no ${kind}`, {
				file: rel(ctx, join(parent, name)),
			}),
		);
	}
	return out;
}

const checkDirs: VerifyCheck = (ctx) => {
	const out = ctx.graph.nodes.flatMap((n) => nodeDirIssues(ctx, n));
	const hexes = (kind: NodeRecord["kind"]) =>
		new Set(ctx.graph.nodes.filter((n) => n.kind === kind).map((n) => hexOf(n.id)));
	out.push(...orphanDirs(ctx, ctx.paths.sprouts, "sprout", hexes("sprout")));
	out.push(...orphanDirs(ctx, ctx.paths.notes, "idea", hexes("idea")));
	return out;
};

// ── The human/ tree ───────────────────────────────────────────────────────

interface Walk {
	ctx: VerifyContext;
	realHuman: string;
	out: VerifyIssue[];
}

function checkSymlink(w: Walk, p: string): void {
	const target = realOrSelf(p);
	if (existsSync(p) && isInside(w.realHuman, target)) return;
	const why = existsSync(p) ? `points outside .luuna/roots/human/ (${target})` : "is dangling";
	w.out.push(
		issue("boundary.symlink", "error", `${rel(w.ctx, p)} is a symlink that ${why}`, {
			file: rel(w.ctx, p),
		}),
	);
}

/** Walk everything under `dir`; `allowed(name, isDir)` says what may live directly in it. */
function walkTree(w: Walk, dir: string, allowed: (name: string, isDir: boolean) => boolean): void {
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		const st = lstat(p);
		if (!st || IGNORED_NAMES.has(name)) continue;
		if (st.isSymbolicLink()) {
			checkSymlink(w, p);
			continue;
		}
		if (name.startsWith(".")) {
			w.out.push(
				issue("boundary.hidden", "warning", `${rel(w.ctx, p)}: hidden file under .luuna/roots/human/`, {
					file: rel(w.ctx, p),
				}),
			);
			continue;
		}
		if (!allowed(name, st.isDirectory())) {
			w.out.push(
				issue(
					"boundary.stray",
					"error",
					`${rel(w.ctx, p)} is not an idea.md or assets/ of a known idea`,
					{
						file: rel(w.ctx, p),
					},
				),
			);
			continue;
		}
		// Anything goes inside assets/ (only symlinks are checked).
		if (st.isDirectory()) walkTree(w, p, () => true);
	}
}

function nodeEntry(name: string, isDir: boolean): boolean {
	return (name === "idea.md" && !isDir) || (name === "assets" && isDir);
}

const checkHumanTree: VerifyCheck = (ctx) => {
	const human = ctx.paths.human;
	const st = lstat(human);
	if (!st) return [];
	if (st.isSymbolicLink()) {
		return [
			issue("boundary.symlink", "error", ".luuna/roots/human is a symlink", { file: rel(ctx, human) }),
		];
	}
	const ideaHexes = new Set(
		ctx.graph.nodes.filter((n) => n.kind === "idea").map((n) => hexOf(n.id)),
	);
	const w: Walk = { ctx, realHuman: realOrSelf(human), out: [] };
	for (const name of readdirSync(human).sort()) {
		const p = join(human, name);
		const s = lstat(p);
		if (!s || IGNORED_NAMES.has(name)) continue;
		if (s.isSymbolicLink()) {
			checkSymlink(w, p);
			continue;
		}
		const hex = dirHex(name);
		if (s.isDirectory() && hex !== null && ideaHexes.has(hex)) {
			walkTree(w, p, nodeEntry);
		} else if (name.startsWith(".")) {
			w.out.push(
				issue("boundary.hidden", "warning", `${rel(ctx, p)}: hidden file under .luuna/roots/human/`, {
					file: rel(ctx, p),
				}),
			);
		} else {
			w.out.push(
				issue("boundary.stray", "error", `${rel(ctx, p)} is not the directory of a known idea`, {
					file: rel(ctx, p),
				}),
			);
		}
	}
	return w.out;
};

// ── Hash ledger ───────────────────────────────────────────────────────────

const TRUSTED_EVENTS = new Set(["plant", "session.end"]);

/** Latest hash recorded for `id` by a human plant / session.end (file order). */
export function lastTrustedHash(events: readonly EventRecord[], id: string): string | null {
	let hash: string | null = null;
	for (const e of events) {
		if (e.node !== id || !TRUSTED_EVENTS.has(String(e.type))) continue;
		if (typeof e.by !== "string" || !e.by.startsWith("human:")) continue;
		if (typeof e.hash === "string") hash = e.hash;
	}
	return hash;
}

function ledgerIssue(ctx: VerifyContext, n: NodeRecord, file: string): VerifyIssue | null {
	const at = { node: n.id, file: rel(ctx, file) };
	const trusted = lastTrustedHash(ctx.events, n.id);
	if (trusted === null) {
		return issue(
			"ledger.missing",
			"warning",
			`${label(n)}: no recorded hash (plant or think session) to check idea.md against`,
			at,
		);
	}
	if (contentHash(readFileSync(file, "utf8")) === trusted) return null;
	if (!ctx.git.available) {
		return issue(
			"ledger.unverifiable",
			"warning",
			`${label(n)}: idea.md changed since its last think session, and git is unavailable to check who changed it`,
			at,
		);
	}
	if (ctx.git.fileState(file) !== "clean") {
		return issue(
			"ledger.untrusted-edit",
			"error",
			`${label(n)}: idea.md changed outside a think session and the change is not committed. If you wrote it, run \`luuna-roots think ${n.id}\` or commit it; otherwise restore it (git checkout)`,
			at,
		);
	}
	const commit = ctx.git.lastCommit(file);
	const agent = commit ? isAgentCommit(commit) : "no commit found";
	if (agent === null) return null;
	return issue(
		"ledger.agent-commit",
		"error",
		`${label(n)}: idea.md changed outside a think session in commit ${commit?.sha.slice(0, 8) ?? "?"} (${agent}); agents never write human ideas`,
		at,
	);
}

const checkLedger: VerifyCheck = (ctx) => {
	const out: VerifyIssue[] = [];
	for (const n of ctx.graph.nodes) {
		if (n.kind !== "idea") continue;
		const dir = locateNodeDir(ctx.paths, n, ctx.dirs);
		const file = dir === null ? null : join(dir, "idea.md");
		if (file === null || !lstat(file)?.isFile()) continue;
		const found = ledgerIssue(ctx, n, file);
		if (found) out.push(found);
	}
	return out;
};

export const boundaryChecks: readonly VerifyCheck[] = [checkDirs, checkHumanTree, checkLedger];
