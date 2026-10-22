// proposals.jsonl: pending agent/rule suggestions (roots-9c29).
//
// Everything that files a proposal goes through fileProposals(), which runs
// the deterministic checks under the proposals lock:
//   1. expire: pending proposals past expiresAt, or moot ones (an endpoint
//      idea composted or gone, an endpoint sprout no longer open), become
//      `expired` (one `expire` event each, with `reason: ttl|moot`)
//   2. citations: every quote is an exact substring of the cited node's prose
//      (and edge/merge need >= 2 cites, split/compost >= 1)
//   3. permanent rejections: a human rejection of the same (kind, from, to,
//      rel) blocks the draft forever; for a rel-less edge draft (mentions),
//      any rejected edge proposal on the same pair blocks it
//   4. duplicates: a pending proposal of the same kind on the same pair
//      (edge pairs are unordered, so deterministic and agent proposals for
//      one pair become one card), or an existing edge on the pair
//   5. cap: pending count stays below limits.proposals
// Tier checks belong to the caller: deterministic mention proposals
// (`roots:mention`) are allowed at every tier; `luuna-roots propose` (Stage 4)
// must check tier >= 2 before calling.
//
// `strict: true` throws a ValidationError/ConflictError on the first failing
// draft (for `luuna-roots propose`); otherwise failing drafts are skipped and
// reported (for automatic filing at session end and in `luuna-roots scan`).

import { readClaim } from "./endorse.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { appendEvent, makeEvent } from "./events.ts";
import { readGraph } from "./graph.ts";
import { generateId, hexSet } from "./ids.ts";
import type { RootsPaths } from "./paths.ts";
import { readTable, updateTable } from "./store.ts";
import { isoNow } from "./time.ts";
import type {
	Actor,
	Citation,
	EdgeRel,
	Graph,
	NodeRecord,
	ProposalKind,
	ProposalRecord,
} from "./types.ts";

export const MENTION_ACTOR = "roots:mention";
const DAY_MS = 86_400_000;

export interface ProposalDraft {
	kind: ProposalKind;
	from?: string;
	to?: string;
	rel?: EdgeRel | null;
	reason?: string;
	cites: Citation[];
	by: Actor;
}

export type SkipReason = "invalid" | "rejected" | "duplicate" | "exists" | "cap";

export interface SkippedDraft {
	draft: ProposalDraft;
	reason: SkipReason;
	message: string;
}

export interface ExpiredProposal {
	proposal: ProposalRecord;
	/** `ttl` (past expiresAt) or `moot: <why>` (see mootReason). */
	reason: string;
}

export interface FileResult {
	filed: ProposalRecord[];
	skipped: SkippedDraft[];
	expired: ProposalRecord[];
	/** Why each entry of `expired` expired (same order). */
	expiredWhy: string[];
}

export interface FileOptions {
	/** limits.proposals from config. */
	cap: number;
	/** limits.proposalTtlDays from config. */
	ttlDays: number;
	now?: Date;
	strict?: boolean;
}

export function readProposals(paths: RootsPaths): ProposalRecord[] {
	return readTable<ProposalRecord>(paths.proposals);
}

export function isExpired(p: ProposalRecord, now: Date): boolean {
	return (
		p.status === "pending" && p.expiresAt !== undefined && Date.parse(p.expiresAt) <= now.getTime()
	);
}

/**
 * Why a pending proposal can no longer be decided, or null when it still
 * can: one of its nodes is gone, a composted idea, or a sprout that is no
 * longer open (adopted, rejected, expired or overdue). Moot proposals are
 * expired lazily exactly like overdue ones (see expireRows); read paths that
 * pass a graph to pendingProposals hide them before that write happens.
 */
export function mootReason(p: ProposalRecord, graph: Graph, now: Date): string | null {
	for (const id of [p.from, p.to]) {
		if (id === undefined) continue;
		const n = graph.nodes.find((x) => x.id === id);
		if (!n) return `${id} is gone`;
		if (n.kind === "idea" && n.status === "composted") return `${id} is composted`;
		if (n.kind === "sprout" && !sproutStillOpen(n, now)) return `sprout ${id} is no longer open`;
	}
	return null;
}

/** Local copy of sprouts.ts isOpenSprout (sprouts.ts imports this module). */
function sproutStillOpen(n: NodeRecord, now: Date): boolean {
	if (n.status !== "open") return false;
	return n.expiresAt === undefined || Date.parse(n.expiresAt) > now.getTime();
}

/**
 * Pending, not yet past expiresAt and, when `graph` is given, not moot
 * (read-side view; no writes). Read paths pass the graph so a proposal about
 * a composted idea never shows up in `queue`, `tend` or `show`.
 */
export function pendingProposals(
	rows: readonly ProposalRecord[],
	now: Date,
	graph?: Graph,
): ProposalRecord[] {
	return rows.filter(
		(p) =>
			p.status === "pending" &&
			!isExpired(p, now) &&
			(!graph || mootReason(p, graph, now) === null),
	);
}

export function expiresAt(createdAt: Date, ttlDays: number): string {
	return isoNow(new Date(createdAt.getTime() + ttlDays * DAY_MS));
}

function samePair(a: { from?: string; to?: string }, b: { from?: string; to?: string }): boolean {
	return (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);
}

/** Direction matters only for serves/replaces/derives. */
function sameTarget(p: ProposalRecord, d: ProposalDraft): boolean {
	const directed = d.rel === "serves" || d.rel === "replaces" || d.rel === "derives";
	return directed ? p.from === d.from && p.to === d.to : samePair(p, d);
}

/** A human rejection that permanently blocks this draft, if any. */
export function findRejection(
	rows: readonly ProposalRecord[],
	d: ProposalDraft,
): ProposalRecord | undefined {
	return rows.find((p) => {
		if (p.status !== "rejected" || p.kind !== d.kind) return false;
		if (d.kind === "edge" && (d.rel ?? null) === null) return samePair(p, d);
		return (p.rel ?? null) === (d.rel ?? null) && sameTarget(p, d);
	});
}

export function isMentionProposal(p: Pick<ProposalRecord, "by">): boolean {
	return p.by === MENTION_ACTOR;
}

/**
 * A pending proposal this draft would duplicate: same kind, same pair, and
 * the same source class. A deterministic mention (`roots:mention`) and an
 * agent proposal for one pair are both kept: `tend` shows them as one card
 * (see proposalGroup).
 */
export function findDuplicate(
	rows: readonly ProposalRecord[],
	d: ProposalDraft,
	now: Date,
): ProposalRecord | undefined {
	return pendingProposals(rows, now).find(
		(p) => p.kind === d.kind && samePair(p, d) && isMentionProposal(p) === isMentionProposal(d),
	);
}

/**
 * The pending proposals decided together with `p` (one `tend` card): for an
 * edge, every pending edge proposal on the same unordered pair; otherwise
 * just `p`. `p` itself comes first.
 */
export function proposalGroup(
	rows: readonly ProposalRecord[],
	p: ProposalRecord,
	now: Date,
): ProposalRecord[] {
	if (p.kind !== "edge") return [p];
	const others = pendingProposals(rows, now).filter(
		(x) => x.id !== p.id && x.kind === "edge" && samePair(x, p),
	);
	return [p, ...others];
}

function edgeExists(graph: Graph, d: ProposalDraft): boolean {
	if (d.kind !== "edge") return false;
	return graph.edges.some((e) => samePair(e, d) && (d.rel == null || e.rel === d.rel));
}

const MIN_CITES: Record<ProposalKind, number> = { edge: 2, merge: 2, split: 1, compost: 1 };

/** Nodes that must each be cited: both ends of an edge/merge, the idea of a split/compost. */
function uncitedEndpoint(d: Pick<ProposalDraft, "kind" | "cites" | "from" | "to">): string | null {
	const ends = d.kind === "edge" || d.kind === "merge" ? [d.from, d.to] : [d.from];
	for (const id of ends) {
		if (id !== undefined && !d.cites.some((c) => c.node === id)) return id;
	}
	return null;
}

/** Error message for the first bad citation, or null when all check out. */
export function checkCitations(
	paths: RootsPaths,
	graph: Graph,
	d: Pick<ProposalDraft, "kind" | "cites" | "from" | "to">,
): string | null {
	const min = MIN_CITES[d.kind];
	if (d.cites.length < min) return `${d.kind} proposals need at least ${min} citation(s)`;
	const missing = uncitedEndpoint(d);
	if (missing) return `cite at least one quote from ${missing}`;
	for (const c of d.cites) {
		const node = graph.nodes.find((n) => n.id === c.node);
		if (!node) return `cited node ${c.node} does not exist`;
		if (c.quote.trim() === "") return `empty cite quote for ${c.node}`;
		if (!readClaim(paths, graph, node).text.includes(c.quote)) {
			return `cite quote not found in ${c.node}`;
		}
	}
	return null;
}

interface CheckState {
	paths: RootsPaths;
	graph: Graph;
	rows: ProposalRecord[];
	pending: number;
	opts: FileOptions;
	now: Date;
}

function checkDraft(s: CheckState, d: ProposalDraft): SkippedDraft | null {
	const skip = (reason: SkipReason, message: string): SkippedDraft => ({
		draft: d,
		reason,
		message,
	});
	const bad = checkCitations(s.paths, s.graph, d);
	if (bad) return skip("invalid", bad);
	const rejected = findRejection(s.rows, d);
	if (rejected) return skip("rejected", `a human already rejected this (${rejected.id})`);
	const dup = findDuplicate(s.rows, d, s.now);
	if (dup) return skip("duplicate", `already proposed as ${dup.id}`);
	if (edgeExists(s.graph, d)) return skip("exists", "these nodes are already linked");
	if (s.pending >= s.opts.cap) {
		return skip("cap", `pending proposals are at the limit (${s.opts.cap}); run \`luuna-roots tend\``);
	}
	return null;
}

function strictError(s: SkippedDraft): Error {
	if (s.reason === "invalid") return new ValidationError(s.message);
	return new ConflictError(s.message, { reason: s.reason });
}

function makeRecord(d: ProposalDraft, rows: ProposalRecord[], now: Date, ttl: number) {
	const record: ProposalRecord = {
		id: generateId("p", hexSet(rows.map((r) => r.id))),
		kind: d.kind,
		...(d.from !== undefined ? { from: d.from } : {}),
		...(d.to !== undefined ? { to: d.to } : {}),
		...(d.kind === "edge" ? { rel: d.rel ?? null } : {}),
		...(d.reason !== undefined ? { reason: d.reason } : {}),
		cites: d.cites,
		by: d.by,
		status: "pending",
		createdAt: isoNow(now),
		expiresAt: expiresAt(now, ttl),
	};
	return record;
}

function expireRows(rows: ProposalRecord[], graph: Graph, now: Date): ExpiredProposal[] {
	const expired: ExpiredProposal[] = [];
	for (const p of rows) {
		if (p.status !== "pending") continue;
		const moot = mootReason(p, graph, now);
		const reason = isExpired(p, now) ? "ttl" : moot ? `moot: ${moot}` : null;
		if (!reason) continue;
		p.status = "expired";
		expired.push({ proposal: p, reason });
	}
	return expired;
}

async function logFiling(paths: RootsPaths, result: FileResult): Promise<void> {
	for (const [i, p] of result.expired.entries()) {
		const reason = result.expiredWhy[i] ?? "ttl";
		await appendEvent(paths, makeEvent("expire", "roots", { ...eventFields(p), reason }));
	}
	for (const p of result.filed) {
		await appendEvent(paths, makeEvent("propose", p.by, { ...eventFields(p), rel: p.rel }));
	}
}

function eventFields(p: ProposalRecord): Record<string, unknown> {
	const refs = p.to ? [p.to] : [];
	return { node: p.from, refs, proposal: p.id, kind: p.kind };
}

/**
 * Validate and append drafts. Logs one `expire` event per proposal expired
 * on the way and one `propose` event per proposal filed.
 */
export async function fileProposals(
	paths: RootsPaths,
	drafts: readonly ProposalDraft[],
	opts: FileOptions,
): Promise<FileResult> {
	const now = opts.now ?? new Date();
	const graph = readGraph(paths);
	const result = await updateTable<ProposalRecord, FileResult>(paths.proposals, (rows) => {
		const expired = expireRows(rows, graph, now);
		const state: CheckState = {
			paths,
			graph,
			rows,
			pending: pendingProposals(rows, now).length,
			opts,
			now,
		};
		const out: FileResult = {
			filed: [],
			skipped: [],
			expired: expired.map((e) => e.proposal),
			expiredWhy: expired.map((e) => e.reason),
		};
		for (const d of drafts) {
			const skip = checkDraft(state, d);
			if (skip && opts.strict) throw strictError(skip);
			if (skip) {
				out.skipped.push(skip);
				continue;
			}
			const record = makeRecord(d, rows, now, opts.ttlDays);
			rows.push(record);
			out.filed.push(record);
			state.pending++;
		}
		return { rows, write: expired.length > 0 || out.filed.length > 0, result: out };
	});
	await logFiling(paths, result);
	return result;
}

/**
 * Expire overdue and moot proposals now (at the start of `tend`, before
 * `accept`/`reject`). One `expire` event each, with its reason.
 */
export async function expireProposals(
	paths: RootsPaths,
	now = new Date(),
): Promise<ProposalRecord[]> {
	const graph = readGraph(paths);
	const expired = await updateTable<ProposalRecord, ExpiredProposal[]>(paths.proposals, (rows) => {
		const out = expireRows(rows, graph, now);
		return { rows, write: out.length > 0, result: out };
	});
	await logFiling(paths, {
		filed: [],
		skipped: [],
		expired: expired.map((e) => e.proposal),
		expiredWhy: expired.map((e) => e.reason),
	});
	return expired.map((e) => e.proposal);
}
