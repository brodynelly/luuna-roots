// `luuna-roots tend`, pure part: cards and the key reducer (the card renderer lives in
// tend-render.ts, roots-9c29). No I/O here; tend-session.ts is the
// shell that executes decisions.
//
// One card per decision. Pending edge proposals on the same unordered pair
// (a deterministic `roots:mention` and an agent's proposal) merge into one
// card; its decision goes to the card's primary proposal (the agent's, when
// there is one) and decide.ts decides the whole group. Cards are ordered by
// expiry, soonest first; ones expiring within EXPIRING_SOON_DAYS are flagged.
//
// Sprout cards: one per open sprout. [t] accepts it with thoughts (an inline
// box under the card: enter endorses, ctrl-e continues in $EDITOR; see
// adopt.ts endorse), [y] adopts it by rewriting (tend-session hands off to the
// adopt editor flow), [n]/[r] reject it (permanent), [s] skips.
// Proposal and sprout cards are interleaved by expiry. The reducer only sees
// keys → actions.

import { isMentionProposal } from "./proposals.ts";
import type { Actor, EdgeRel, ProposalKind, ProposalRecord } from "./types.ts";

export const EXPIRING_SOON_DAYS = 3;
const DAY_MS = 86_400_000;

export interface CardNode {
	id: string;
	slug: string;
}

export interface CardCite {
	node: string;
	quote: string;
}

export interface ProposalCard {
	type: "proposal";
	/** The id decisions go to (the primary proposal). */
	id: string;
	ids: string[];
	kind: ProposalKind;
	from: CardNode;
	to: CardNode | null;
	/** Suggested relation (edge), or null when only a mention links the pair. */
	rel: EdgeRel | null;
	/** Some member names no relation: the human picks one ([1] [2] [3]). */
	pickRel: boolean;
	sources: Actor[];
	/** The agent's reason, quoted on the card. */
	reason: string | null;
	/** Deterministic notes (e.g. how a mention matched). */
	notes: string[];
	cites: CardCite[];
	expiresAt: string | null;
}

export interface SproutCard {
	type: "sprout";
	id: string;
	ids: string[];
	slug: string;
	statement: string;
	/** Prose after the statement (shown in full, clamped to the terminal). */
	body: string;
	author: Actor;
	expiresAt: string | null;
}

export type TendCard = ProposalCard | SproutCard;

export interface SproutSource {
	id: string;
	slug: string;
	author: Actor;
	expiresAt?: string;
	statement: string;
	body: string;
}

export function sproutCard(s: SproutSource): SproutCard {
	return {
		type: "sprout",
		id: s.id,
		ids: [s.id],
		slug: s.slug,
		statement: s.statement,
		body: s.body,
		author: s.author,
		expiresAt: s.expiresAt ?? null,
	};
}

/** Soonest expiry first; cards without an expiry last. Stable. */
export function sortCards(cards: TendCard[]): TendCard[] {
	return [...cards].sort((a, b) => (a.expiresAt ?? "~").localeCompare(b.expiresAt ?? "~"));
}

export type TendAction =
	| { type: "accept"; rel?: EdgeRel; keep?: string }
	| { type: "reject"; reason?: string }
	| { type: "skip" }
	| { type: "quit" }
	/** Accept a sprout as written with the human's thoughts; `editor` continues in $EDITOR. */
	| { type: "endorse"; text: string; editor: boolean };

export interface CardKey {
	key: string;
	label: string;
	action: TendAction | { type: "reason" } | { type: "thoughts" };
}

// ── cards ───────────────────────────────────────────────────────────────────

function pairKey(p: ProposalRecord): string {
	return [p.from ?? "", p.to ?? ""].sort().join("|");
}

function soonest(ps: readonly ProposalRecord[]): string | null {
	const all = ps.map((p) => p.expiresAt).filter((x): x is string => typeof x === "string");
	return all.sort()[0] ?? null;
}

function uniqueCites(ps: readonly ProposalRecord[]): CardCite[] {
	const seen = new Set<string>();
	const out: CardCite[] = [];
	for (const c of ps.flatMap((p) => p.cites)) {
		const k = `${c.node}\u0000${c.quote}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({ node: c.node, quote: c.quote });
	}
	return out;
}

function toCard(group: ProposalRecord[], node: (id: string) => CardNode): ProposalCard {
	const primary = group.find((p) => !isMentionProposal(p)) ?? (group[0] as ProposalRecord);
	const agent = group.filter((p) => !isMentionProposal(p));
	return {
		type: "proposal",
		id: primary.id,
		ids: [primary.id, ...group.filter((p) => p !== primary).map((p) => p.id)],
		kind: primary.kind,
		from: node(primary.from ?? ""),
		to: primary.to ? node(primary.to) : null,
		rel: primary.kind === "edge" ? (primary.rel ?? null) : null,
		pickRel: primary.kind === "edge" && group.some((p) => p.rel == null),
		sources: [...new Set(group.map((p) => p.by))],
		reason: agent[0]?.reason ?? null,
		notes: group.filter(isMentionProposal).map((p) => p.reason ?? "mention"),
		cites: uniqueCites(group),
		expiresAt: soonest(group),
	};
}

/** Cards for pending proposals: edge proposals on one pair merge; soonest expiry first. */
export function proposalCards(
	pending: readonly ProposalRecord[],
	node: (id: string) => CardNode,
): ProposalCard[] {
	const groups = new Map<string, ProposalRecord[]>();
	for (const p of pending) {
		const key = p.kind === "edge" ? `edge|${pairKey(p)}` : p.id;
		groups.set(key, [...(groups.get(key) ?? []), p]);
	}
	return [...groups.values()]
		.map((g) => toCard(g, node))
		.sort((a, b) => (a.expiresAt ?? "~").localeCompare(b.expiresAt ?? "~"));
}

export function daysLeft(expiresAt: string | null, now: Date): number | null {
	if (!expiresAt) return null;
	return Math.max(0, Math.ceil((Date.parse(expiresAt) - now.getTime()) / DAY_MS));
}

export function expiringSoon(card: TendCard, now: Date): boolean {
	const d = daysLeft(card.expiresAt, now);
	return d !== null && d <= EXPIRING_SOON_DAYS;
}

// ── keys ────────────────────────────────────────────────────────────────────

const REL_KEYS: [string, EdgeRel][] = [
	["1", "serves"],
	["2", "tension"],
	["3", "replaces"],
];

const REJECT_KEYS: CardKey[] = [
	{ key: "n", label: "reject", action: { type: "reject" } },
	{ key: "r", label: "reject w/ reason", action: { type: "reason" } },
	{ key: "s", label: "skip", action: { type: "skip" } },
];

function acceptKeys(card: ProposalCard): CardKey[] {
	if (card.kind === "merge" && card.to) {
		return [
			{ key: "1", label: `keep ${card.from.slug}`, action: { type: "accept", keep: card.from.id } },
			{ key: "2", label: `keep ${card.to.slug}`, action: { type: "accept", keep: card.to.id } },
		];
	}
	if (card.kind !== "edge") {
		const label = card.kind === "split" ? "accept + think now" : "accept";
		return [{ key: "y", label, action: { type: "accept" } }];
	}
	const keys: CardKey[] = card.rel
		? [{ key: "y", label: `accept ${card.rel}`, action: { type: "accept" } }]
		: [];
	if (!card.pickRel) return [{ key: "y", label: "accept", action: { type: "accept" } }];
	for (const [key, rel] of REL_KEYS)
		keys.push({ key, label: rel, action: { type: "accept", rel } });
	return keys;
}

export function cardKeys(card: TendCard): CardKey[] {
	if (card.type === "sprout") {
		return [
			{ key: "t", label: "accept w/ thoughts", action: { type: "thoughts" } },
			{ key: "y", label: "rewrite as my idea", action: { type: "accept" } },
			...REJECT_KEYS,
		];
	}
	return [...acceptKeys(card), ...REJECT_KEYS];
}

// ── reducer ─────────────────────────────────────────────────────────────────

export type TendOutcome = "accepted" | "rejected" | "skipped";

export interface TendState {
	cards: TendCard[];
	index: number;
	/** Typing a rejection reason. */
	reason: string | null;
	/** Typing thoughts on a sprout ([t]). */
	thoughts: string | null;
	/** A decision is being executed; input waits. */
	busy: boolean;
	outcomes: Record<string, TendOutcome>;
	notice: string | null;
	error: string | null;
	ended: boolean;
}

export type TendInput =
	| { type: "data"; data: string }
	| { type: "done"; ok: true; outcome: TendOutcome; notice?: string }
	| { type: "done"; ok: false; error: string };

export type TendEffect = { type: "decide"; card: TendCard; action: TendAction };

export interface TendStep {
	state: TendState;
	effects: TendEffect[];
}

export function initialTend(cards: TendCard[]): TendState {
	return {
		cards,
		index: 0,
		reason: null,
		thoughts: null,
		busy: false,
		outcomes: {},
		notice: null,
		error: null,
		ended: cards.length === 0,
	};
}

export function currentCard(s: TendState): TendCard | null {
	return s.ended ? null : (s.cards[s.index] ?? null);
}

function advance(s: TendState, card: TendCard, outcome: TendOutcome, notice?: string): TendState {
	const index = s.index + 1;
	return {
		...s,
		index,
		busy: false,
		outcomes: { ...s.outcomes, [card.id]: outcome },
		notice: notice ?? null,
		error: null,
		ended: index >= s.cards.length,
	};
}

function act(s: TendState, card: TendCard, action: TendAction): TendStep {
	if (action.type === "quit") return { state: { ...s, ended: true }, effects: [] };
	if (action.type === "skip") return { state: advance(s, card, "skipped"), effects: [] };
	return {
		state: { ...s, busy: true, error: null, reason: null, thoughts: null },
		effects: [{ type: "decide", card, action }],
	};
}

function onReasonChar(s: TendState, card: TendCard, ch: string): TendStep {
	const text = s.reason ?? "";
	if (ch === "\r" || ch === "\n") {
		const reason = text.trim();
		if (reason === "")
			return { state: { ...s, reason: null, notice: "no reason; not rejected" }, effects: [] };
		return act(s, card, { type: "reject", reason });
	}
	if (ch === "\x1b") return { state: { ...s, reason: null, notice: "cancelled" }, effects: [] };
	return { state: { ...s, reason: edited(text, ch) }, effects: [] };
}

/** Printable input appended to `text`; backspace deletes; other controls are ignored. */
function edited(text: string, ch: string): string {
	if (ch === "\x7f" || ch === "\b") return text.slice(0, -1);
	return ch < " " ? text : text + ch;
}

function onThoughtsChar(s: TendState, card: TendCard, ch: string): TendStep {
	const text = s.thoughts ?? "";
	if (ch === "\x1b") return { state: { ...s, thoughts: null, notice: "cancelled" }, effects: [] };
	if (ch === "\x05") return act(s, card, { type: "endorse", text: text.trim(), editor: true });
	if (ch === "\r" || ch === "\n") {
		if (text.trim() === "") {
			return {
				state: { ...s, error: "write a thought first (or ctrl-e for $EDITOR)" },
				effects: [],
			};
		}
		return act(s, card, { type: "endorse", text: text.trim(), editor: false });
	}
	return { state: { ...s, thoughts: edited(text, ch), error: null }, effects: [] };
}

function onCardKey(s: TendState, card: TendCard, ch: string): TendStep {
	const k = ch.toLowerCase();
	if (k === "q") return act(s, card, { type: "quit" });
	const hit = cardKeys(card).find((x) => x.key === k);
	if (!hit) return { state: s, effects: [] };
	if (hit.action.type === "reason") {
		return { state: { ...s, reason: "", notice: null, error: null }, effects: [] };
	}
	if (hit.action.type === "thoughts") {
		return { state: { ...s, thoughts: "", notice: null, error: null }, effects: [] };
	}
	return act(s, card, hit.action);
}

/** Split raw terminal input into characters, dropping escape sequences (arrows etc.). */
export function inputChars(data: string): string[] {
	const out: string[] = [];
	const chars = [...data];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i] ?? "";
		if (ch === "\x1b" && chars[i + 1] === "[") {
			i += 2;
			continue;
		}
		out.push(ch);
	}
	return out;
}

function onChar(s: TendState, ch: string): TendStep {
	const card = currentCard(s);
	if (!card) return { state: s, effects: [] };
	if (ch === "\x03" || ch === "\x04") return act(s, card, { type: "quit" });
	if (s.thoughts !== null) return onThoughtsChar(s, card, ch);
	return s.reason !== null ? onReasonChar(s, card, ch) : onCardKey(s, card, ch);
}

function onData(s: TendState, data: string): TendStep {
	let state = s;
	const effects: TendEffect[] = [];
	for (const ch of inputChars(data)) {
		if (state.ended || state.busy) break;
		const r = onChar(state, ch);
		state = r.state;
		effects.push(...r.effects);
	}
	return { state, effects };
}

export function tendStep(s: TendState, input: TendInput): TendStep {
	if (s.ended) return { state: s, effects: [] };
	if (input.type === "data") return s.busy ? { state: s, effects: [] } : onData(s, input.data);
	const card = currentCard(s);
	if (!card) return { state: s, effects: [] };
	if (!input.ok) return { state: { ...s, busy: false, error: input.error }, effects: [] };
	return { state: advance(s, card, input.outcome, input.notice), effects: [] };
}

export interface TendTally {
	accepted: number;
	rejected: number;
	skipped: number;
	/** Cards not reached (quit early). */
	left: number;
}

export function tendTally(s: TendState): TendTally {
	const t: TendTally = { accepted: 0, rejected: 0, skipped: 0, left: 0 };
	for (const c of s.cards) {
		const o = s.outcomes[c.id];
		if (o) t[o]++;
		else t.left++;
	}
	return t;
}
