// `luuna-roots flow`, the pure parts (roots-3ad0): the trail (what this flow did,
// read back from events.jsonl), the next-idea picks, and the transition
// card's key reducer. flow-render.ts draws the card; flow-session.ts is the
// shell that runs think sessions, tend, plant and the background agent.
//
// Keys on the transition card:
//   enter  the recommended step: review the inbox when it has cards, else
//          think about the current pick
//   n      think about the current pick     o  show the next pick
//   p      plant a new idea                 x  dismiss the agent's heading
//   q      end the flow (Ctrl-C / Ctrl-D too)

import { findingsReady, type IdeaAttention } from "./attention.ts";
import { isDue } from "./questions.ts";
import type {
	EventRecord,
	Graph,
	HeadingRecord,
	NodeRecord,
	NodeStatus,
	QuestionRecord,
} from "./types.ts";

export interface TrailEntry {
	id: string;
	slug: string;
	status: NodeStatus;
	/** Think sessions in this flow. */
	sessions: number;
	answered: number;
	/** Questions still open (or due again) on the idea now. */
	open: number;
}

export interface FlowTrail {
	/** Ideas thought about, in first-touch order. */
	entries: TrailEntry[];
	/** The idea of the latest session. */
	current: string | null;
	planted: string[];
	adopted: string[];
	accepted: number;
	rejected: number;
}

/** Events logged by `flow`'s own human process after its flow.start (and before flow.end). */
export function flowEvents(events: readonly EventRecord[], flow: string): EventRecord[] {
	const start = events.findIndex((e) => e.type === "flow.start" && e.flow === flow);
	if (start === -1) return [];
	const by = events[start]?.by;
	const out: EventRecord[] = [];
	for (const e of events.slice(start + 1)) {
		if (e.type === "flow.end" && e.flow === flow) break;
		if (e.by === by) out.push(e);
	}
	return out;
}

function emptyTrail(): FlowTrail {
	return { entries: [], current: null, planted: [], adopted: [], accepted: 0, rejected: 0 };
}

function recordSession(trail: FlowTrail, byId: Map<string, TrailEntry>, e: EventRecord): void {
	const id = e.node as string;
	let entry = byId.get(id);
	if (!entry) {
		entry = { id, slug: "?", status: "planted", sessions: 0, answered: 0, open: 0 };
		byId.set(id, entry);
		trail.entries.push(entry);
	}
	entry.sessions++;
	entry.answered += typeof e.answered === "number" ? e.answered : 0;
	trail.current = id;
}

function recordEvent(trail: FlowTrail, byId: Map<string, TrailEntry>, e: EventRecord): void {
	if (e.type === "session.end" && e.node) recordSession(trail, byId, e);
	else if (e.type === "plant" && e.node) {
		(typeof e.sprout === "string" ? trail.adopted : trail.planted).push(e.node);
	} else if (e.type === "accept" && typeof e.proposal === "string") trail.accepted++;
	else if (e.type === "reject") trail.rejected++;
}

export function buildTrail(
	events: readonly EventRecord[],
	graph: Graph,
	questions: readonly QuestionRecord[],
	flow: string,
	now: Date,
): FlowTrail {
	const trail = emptyTrail();
	const byId = new Map<string, TrailEntry>();
	for (const e of flowEvents(events, flow)) recordEvent(trail, byId, e);
	for (const entry of trail.entries) {
		const node = graph.nodes.find((n) => n.id === entry.id);
		if (node) {
			entry.slug = node.slug;
			entry.status = node.status;
		}
		entry.open = questions.filter((q) => q.node === entry.id && isDue(q, now)).length;
	}
	return trail;
}

export interface FlowPick {
	id: string;
	slug: string;
	reason: string;
	/** The agent's heading suggested it. */
	fromHeading: boolean;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function pickReason(a: IdeaAttention): string {
	if (findingsReady(a) > 0) return "agent findings ready";
	if (a.due.length > 0) return plural(a.due.length, "open question");
	if (a.activity.sessions === 0) return "never thought";
	return plural(a.candidates.length, "new question");
}

/**
 * What to think about next: the heading's suggestion first (when it is a live
 * idea), then ideas in need that this flow has not touched, then the touched
 * ones (their open questions bring you back, but after fresh ground).
 */
export function rankPicks(
	ranked: readonly IdeaAttention[],
	touched: ReadonlySet<string>,
	graph: Graph,
	headingNext?: string,
): FlowPick[] {
	const toPick = (a: IdeaAttention): FlowPick => ({
		id: a.node.id,
		slug: a.node.slug,
		reason: pickReason(a),
		fromHeading: a.node.id === headingNext,
	});
	const fresh = ranked.filter((a) => !touched.has(a.node.id)).map(toPick);
	const again = ranked.filter((a) => touched.has(a.node.id)).map(toPick);
	const picks = [...fresh, ...again];
	if (!headingNext) return picks;
	const at = picks.findIndex((p) => p.id === headingNext);
	if (at >= 0) {
		const [hit] = picks.splice(at, 1);
		return hit ? [hit, ...picks] : picks;
	}
	const node = graph.nodes.find((n) => n.id === headingNext);
	if (!node || !isThinkable(node)) return picks;
	return [
		{ id: node.id, slug: node.slug, reason: "the heading suggests it", fromHeading: true },
		...picks,
	];
}

function isThinkable(node: NodeRecord): boolean {
	return node.kind === "idea" && ["planted", "shaping", "committed"].includes(node.status);
}

// ── transition card ─────────────────────────────────────────────────────────

/** Heading section: off (no agent/tier/config), waiting (run in progress), none, or shown. */
export type HeadingView =
	| { kind: "off" }
	| { kind: "waiting" }
	| { kind: "none" }
	| { kind: "shown"; heading: HeadingRecord };

export interface FlowCard {
	trail: FlowTrail;
	heading: HeadingView;
	/** Labels of background agent runs still going. */
	jobs: string[];
	/** Pending tend cards (proposals + sprouts). */
	inbox: number;
	picks: FlowPick[];
	pick: number;
	/** Last thing that happened (session tally, plant, dismissal, a failed agent run). */
	notice: string | null;
	ended: boolean;
}

export type FlowKey = "enter" | "n" | "o" | "p" | "x" | "q";

export type FlowAction =
	| { type: "think"; id: string }
	| { type: "tend" }
	| { type: "plant" }
	| { type: "dismiss"; heading: string }
	| { type: "quit" };

export function initialCard(): FlowCard {
	return {
		trail: emptyTrail(),
		heading: { kind: "off" },
		jobs: [],
		inbox: 0,
		picks: [],
		pick: 0,
		notice: null,
		ended: false,
	};
}

export function currentPick(card: FlowCard): FlowPick | null {
	return card.picks[card.pick] ?? card.picks[0] ?? null;
}

/** What [enter] does right now. */
export function enterAction(card: FlowCard): FlowAction | null {
	if (card.inbox > 0) return { type: "tend" };
	const pick = currentPick(card);
	return pick ? { type: "think", id: pick.id } : { type: "plant" };
}

export function flowKey(
	card: FlowCard,
	key: FlowKey,
): { card: FlowCard; action: FlowAction | null } {
	const none = (notice: string) => ({ card: { ...card, notice }, action: null });
	switch (key) {
		case "q":
			return { card: { ...card, ended: true }, action: { type: "quit" } };
		case "enter":
			return { card, action: enterAction(card) };
		case "n": {
			const pick = currentPick(card);
			return pick
				? { card, action: { type: "think", id: pick.id } }
				: none("nothing needs thinking; [p] plants");
		}
		case "o":
			if (card.picks.length < 2) return none("no other idea needs thinking");
			return {
				card: { ...card, pick: (card.pick + 1) % card.picks.length, notice: null },
				action: null,
			};
		case "p":
			return { card, action: { type: "plant" } };
		case "x":
			if (card.heading.kind !== "shown") return none("no heading to dismiss");
			return { card, action: { type: "dismiss", heading: card.heading.heading.id } };
	}
}

/** Raw terminal input → card keys. */
export function parseFlowKeys(data: string): FlowKey[] {
	const out: FlowKey[] = [];
	for (const ch of data) {
		const k = ch.toLowerCase();
		if (ch === "\r" || ch === "\n") out.push("enter");
		else if (k === "n" || k === "o" || k === "p" || k === "x" || k === "q") out.push(k);
		else if (ch === "\x03" || ch === "\x04") out.push("q");
	}
	return out;
}
