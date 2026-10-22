// Human decisions on agent suggestions: `luuna-roots accept` / `luuna-roots reject` and
// the keys in `luuna-roots tend`. Dispatches on the id prefix; sprouts (s-) are
// plugged in by sprout-decide.ts with registerDecider("s", ...).
//
// Proposals (p-):
//   edge     creates the edge (by = the human, proposedBy/proposal = the
//            proposal). A mention proposal (rel: null) needs a relation
//            (`--rel`). Pending edge proposals on the same pair are one card
//            (proposalGroup) and are decided together: members that match
//            the chosen relation (or have none) are accepted, the others are
//            rejected with "human chose <rel>".
//   merge    needs the survivor (`--keep <id>`); the survivor `replaces` the
//            other idea, which is composted.
//   split    is only marked accepted: the human does the split in a think
//            session (`tend` starts one with the proposal as guidance).
//   compost  composts the idea.
// Rejections are permanent memory (proposals.findRejection).
//
// Lock order: proposals.jsonl, then graph.jsonl inside it (edges.ts).
// Events are written after the locks are released, one per decided
// proposal, plus one `status`/`compost` event per idea composted.

import { parseLinkRel } from "./agent-proposals.ts";
import { addEdge } from "./edges.ts";
import { ConflictError, NotFoundError, UsageError } from "./errors.ts";
import { appendEvent, makeEvent } from "./events.ts";
import { findNode, readGraph } from "./graph.ts";
import { prefixOf } from "./ids.ts";
import { type StatusChange, setIdeaStatus, statusEvent } from "./lifecycle.ts";
import type { RootsPaths } from "./paths.ts";
import { expireProposals, proposalGroup } from "./proposals.ts";
import { updateTable } from "./store.ts";
import { isoNow } from "./time.ts";
import type {
	Actor,
	EdgeRecord,
	EdgeRel,
	EventRecord,
	NodeRecord,
	ProposalRecord,
} from "./types.ts";

export interface DecideContext {
	paths: RootsPaths;
	/** The deciding human (`human:<name>`). */
	by: Actor;
	now?: Date;
	/**
	 * Accepting a sprout means adopting it: the human writes the idea in
	 * $EDITOR. Only callers with an interactive terminal (`luuna-roots accept` on a
	 * TTY, `luuna-roots tend`) provide this; without it, accepting a sprout fails
	 * with a pointer to `luuna-roots adopt`.
	 */
	adopt?: (sproutId: string) => Promise<Decision>;
}

export interface AcceptOptions {
	/** Relation for a mention proposal (rel: null). */
	rel?: string;
	/** Survivor of a merge (node id among the two). */
	keep?: string;
	/** Optional note recorded as decisionReason. */
	reason?: string;
}

export interface NodeStatusChange extends StatusChange {
	node: string;
}

export interface Decision {
	/** The id the human decided on. */
	id: string;
	action: "accept" | "reject";
	/** Every record decided (a whole tend card). */
	proposals: ProposalRecord[];
	edge: EdgeRecord | null;
	statusChanges: NodeStatusChange[];
	/** Split accepted: the human should now think about this idea with this guidance. */
	think: { node: string; guidance: string } | null;
	/** Sprout decisions (s-): the sprout after the decision and, when adopted, the new idea. */
	sprout?: { node: NodeRecord; idea: NodeRecord | null; file: string | null };
}

export interface Decider {
	accept(ctx: DecideContext, id: string, opts: AcceptOptions): Promise<Decision>;
	reject(ctx: DecideContext, id: string, reason?: string): Promise<Decision>;
}

const DECIDERS = new Map<string, Decider>();

/** Plug in a decider for an id prefix (`p` proposals here; `s` sprouts in sprout-decide.ts). */
export function registerDecider(prefix: string, decider: Decider): void {
	DECIDERS.set(prefix, decider);
}

function deciderFor(rawId: string): { id: string; decider: Decider } {
	const id = rawId.trim().toLowerCase();
	const prefix = prefixOf(id);
	if (prefix !== "p" && prefix !== "s") {
		throw new UsageError(`expected a proposal (p-xxxx) or sprout (s-xxxx) id, got "${rawId}"`);
	}
	const decider = DECIDERS.get(prefix);
	if (!decider) throw new UsageError(`no decider registered for ${prefix}- ids`);
	return { id, decider };
}

export function acceptItem(ctx: DecideContext, id: string, opts: AcceptOptions = {}) {
	const d = deciderFor(id);
	return d.decider.accept(ctx, d.id, opts);
}

export function rejectItem(ctx: DecideContext, id: string, reason?: string) {
	const d = deciderFor(id);
	return d.decider.reject(ctx, d.id, reason);
}

// ── proposals ──────────────────────────────────────────────────────────────

function findPending(rows: ProposalRecord[], id: string): ProposalRecord {
	const p = rows.find((r) => r.id === id);
	if (!p) throw new NotFoundError(`no proposal ${id}; \`luuna-roots tend\` lists pending proposals`);
	if (p.status !== "pending") {
		const who = p.decidedBy ? ` by ${p.decidedBy}` : "";
		throw new ConflictError(`${id} is already ${p.status}${who}`, { status: p.status });
	}
	return p;
}

interface EdgeChoice {
	rel: EdgeRel;
	/** The proposal the edge is attributed to (its direction is used). */
	source: ProposalRecord;
}

function chooseRel(group: ProposalRecord[], raw: string | undefined): EdgeChoice {
	const [p] = group;
	const withRel = group.find((x) => x.rel != null);
	const mention = group.find((x) => x.rel == null);
	if (raw === undefined) {
		if (!withRel?.rel) {
			throw new UsageError(
				`${p?.id} links ${p?.from} and ${p?.to} but names no relation; ` +
					"pass --rel serves|tension|replaces",
			);
		}
		return { rel: withRel.rel, source: withRel };
	}
	const rel = parseLinkRel(raw);
	const match = group.find((x) => x.rel === rel) ?? mention;
	if (!match) {
		throw new UsageError(
			`${withRel?.id} proposes \`${withRel?.rel}\`, not \`${rel}\`; ` +
				`reject it and run \`luuna-roots link ${p?.from} ${p?.to} ${rel}\` instead`,
		);
	}
	return { rel, source: match };
}

interface Outcome {
	decided: ProposalRecord[];
	edge: EdgeRecord | null;
	changes: NodeStatusChange[];
	think: Decision["think"];
}

function mark(
	p: ProposalRecord,
	status: "accepted" | "rejected",
	ctx: DecideContext,
	reason?: string,
): void {
	p.status = status;
	p.decidedBy = ctx.by;
	p.decidedAt = isoNow(ctx.now);
	if (reason) p.decisionReason = reason;
	else delete p.decisionReason;
}

async function acceptEdge(
	ctx: DecideContext,
	group: ProposalRecord[],
	opts: AcceptOptions,
): Promise<Outcome> {
	const { rel, source } = chooseRel(group, opts.rel);
	const added = await addEdge(
		ctx.paths,
		{
			from: source.from ?? "",
			to: source.to ?? "",
			rel,
			by: ctx.by,
			proposedBy: source.by,
			proposal: source.id,
		},
		{ now: ctx.now },
	);
	for (const x of group) {
		if (x.rel == null || x.rel === rel) mark(x, "accepted", ctx, opts.reason);
		else mark(x, "rejected", ctx, `human chose ${rel}`);
	}
	const changes = added.composted ? [{ node: added.edge.to, ...added.composted }] : [];
	return { decided: group, edge: added.edge, changes, think: null };
}

function survivor(p: ProposalRecord, keep: string | undefined): { keep: string; other: string } {
	const ends = [p.from ?? "", p.to ?? ""];
	if (keep === undefined) {
		throw new UsageError(
			`merging needs the idea that survives: --keep ${ends[0]} or --keep ${ends[1]}`,
		);
	}
	const k = keep.trim().toLowerCase();
	const hit = ends.find((e) => e === k || e === `r-${k}`);
	if (!hit) throw new UsageError(`--keep must be ${ends[0]} or ${ends[1]}, got "${keep}"`);
	return { keep: hit, other: ends.find((e) => e !== hit) ?? "" };
}

async function acceptMerge(
	ctx: DecideContext,
	p: ProposalRecord,
	opts: AcceptOptions,
): Promise<Outcome> {
	const { keep, other } = survivor(p, opts.keep);
	const added = await addEdge(
		ctx.paths,
		{ from: keep, to: other, rel: "replaces", by: ctx.by, proposedBy: p.by, proposal: p.id },
		{ now: ctx.now },
	);
	mark(p, "accepted", ctx, opts.reason);
	const changes = added.composted ? [{ node: other, ...added.composted }] : [];
	return { decided: [p], edge: added.edge, changes, think: null };
}

async function acceptOne(
	ctx: DecideContext,
	rows: ProposalRecord[],
	id: string,
	opts: AcceptOptions,
): Promise<Outcome> {
	const p = findPending(rows, id);
	const now = ctx.now ?? new Date();
	if (p.kind === "edge") return acceptEdge(ctx, proposalGroup(rows, p, now), opts);
	if (p.kind === "merge") return acceptMerge(ctx, p, opts);
	const node = p.from ?? "";
	if (p.kind === "split") {
		const idea = findNode(readGraph(ctx.paths), node);
		if (!idea || idea.status === "composted") {
			throw new ConflictError(`${node} is ${idea ? "composted" : "gone"}; reject ${p.id} instead`);
		}
		mark(p, "accepted", ctx, opts.reason);
		return { decided: [p], edge: null, changes: [], think: { node, guidance: p.reason ?? "" } };
	}
	const change = await setIdeaStatus(ctx.paths, node, "composted", now);
	mark(p, "accepted", ctx, opts.reason);
	return { decided: [p], edge: null, changes: change ? [{ node, ...change }] : [], think: null };
}

function decisionEvents(ctx: DecideContext, o: Outcome, primary: string): EventRecord[] {
	const events: EventRecord[] = o.decided.map((p) =>
		makeEvent(p.status === "accepted" ? "accept" : "reject", ctx.by, {
			node: p.from,
			refs: p.to ? [p.to] : [],
			proposal: p.id,
			kind: p.kind,
			...(p.kind === "edge" ? { rel: p.rel ?? null } : {}),
			...(o.edge && p.id === o.edge.proposal ? { edge: o.edge.id, edgeRel: o.edge.rel } : {}),
			...(p.decisionReason ? { reason: p.decisionReason } : {}),
			...(p.id !== primary ? { with: primary } : {}),
		}),
	);
	for (const c of o.changes) {
		const { node, ...change } = c;
		const extra = o.edge ? { edge: o.edge.id } : { proposal: primary };
		events.push(statusEvent(ctx.by, node, change, extra, o.edge ? "status" : "compost"));
	}
	return events;
}

async function logAll(paths: RootsPaths, events: EventRecord[]): Promise<void> {
	for (const e of events) await appendEvent(paths, e);
}

function toDecision(id: string, action: Decision["action"], o: Outcome): Decision {
	return {
		id,
		action,
		proposals: o.decided,
		edge: o.edge,
		statusChanges: o.changes,
		think: o.think,
	};
}

export const proposalDecider: Decider = {
	async accept(ctx, id, opts) {
		await expireProposals(ctx.paths, ctx.now);
		const outcome = await updateTable<ProposalRecord, Outcome>(
			ctx.paths.proposals,
			async (rows) => {
				const o = await acceptOne(ctx, rows, id, opts);
				return { rows, write: true, result: o };
			},
		);
		await logAll(ctx.paths, decisionEvents(ctx, outcome, id));
		return toDecision(id, "accept", outcome);
	},
	async reject(ctx, id, reason) {
		await expireProposals(ctx.paths, ctx.now);
		const outcome = await updateTable<ProposalRecord, Outcome>(ctx.paths.proposals, (rows) => {
			const p = findPending(rows, id);
			const group = proposalGroup(rows, p, ctx.now ?? new Date());
			for (const x of group) mark(x, "rejected", ctx, reason?.trim() || undefined);
			const o: Outcome = { decided: group, edge: null, changes: [], think: null };
			return { rows, write: true, result: o };
		});
		await logAll(ctx.paths, decisionEvents(ctx, outcome, id));
		return toDecision(id, "reject", outcome);
	},
};

registerDecider("p", proposalDecider);
