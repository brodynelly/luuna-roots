// The think session as a pure state machine. The imperative shell
// (think-session.ts) feeds it inputs (saves from the file watcher, keys from
// the terminal) and executes the effects it returns (writes to
// questions.jsonl / events.jsonl). No I/O here, so every transition is
// testable without a TTY.
//
//   save (content changed) → answer the current question, advance
//   d → dismiss   z → snooze   s → skip (stays open)   q → end
//   a → hand to the agent (tier ≥ 1; it researches, findings come back here)
// The session ends after the last question is handled, or on q. With no
// questions at all it is a free-writing session that ends only on q.
//
// arrive (agent questions asked mid-session, e.g. by a harness calling
// `luuna-roots ask`): each one is queued before the first unreached rule question,
// never ahead of the current one. The queue stays within `cap`
// (questionsPerSession): when full, the last unreached rule question is
// bumped (it stays open for the next session); when nothing can be bumped,
// the arrival waits for the next session.

import type { DiffSpan } from "./diff.ts";
import type { QuestionRecord } from "./types.ts";

export type Outcome = "answered" | "dismissed" | "snoozed" | "skipped" | "delegated";
export type SessionKey = "d" | "z" | "s" | "q" | "a";
export type EndReason = "completed" | "quit";

export interface SessionState {
	questions: QuestionRecord[];
	/** Index of the current question; === questions.length when none is left. */
	index: number;
	outcomes: Record<string, Outcome>;
	/** Content-changing saves during the session. */
	saves: number;
	ended: EndReason | null;
	/** One-line feedback for the screen (last thing that happened). */
	notice: string | null;
	/** [a] is allowed: agents may work on this idea (tier ≥ 1). */
	canDelegate: boolean;
}

export type SessionInput =
	| { type: "save"; span: DiffSpan; lines?: string[] }
	| { type: "key"; key: SessionKey }
	| { type: "arrive"; questions: QuestionRecord[]; cap: number };

export type SessionEffect =
	| { type: "answer"; question: QuestionRecord; span: DiffSpan; lines?: string[] }
	| { type: "dismiss"; question: QuestionRecord }
	| { type: "snooze"; question: QuestionRecord }
	| { type: "delegate"; question: QuestionRecord }
	| { type: "end"; reason: EndReason };

export interface Step {
	state: SessionState;
	effects: SessionEffect[];
}

export function initialState(questions: QuestionRecord[], canDelegate = false): SessionState {
	return { questions, index: 0, outcomes: {}, saves: 0, ended: null, notice: null, canDelegate };
}

export function currentQuestion(s: SessionState): QuestionRecord | null {
	return s.ended ? null : (s.questions[s.index] ?? null);
}

const PAST: Record<Outcome, string> = {
	answered: "answered",
	dismissed: "dismissed (won't be asked again)",
	snoozed: "snoozed",
	skipped: "skipped (asked again next session)",
	delegated: "handed to the agent (its findings come back here)",
};

const KEY_OUTCOME = { d: "dismissed", z: "snoozed", a: "delegated" } as const;
const KEY_EFFECT = { d: "dismiss", z: "snooze", a: "delegate" } as const;

function resolve(s: SessionState, q: QuestionRecord, outcome: Outcome, detail = ""): Step {
	const index = s.index + 1;
	const done = index >= s.questions.length;
	const state: SessionState = {
		...s,
		index,
		outcomes: { ...s.outcomes, [q.id]: outcome },
		ended: done ? "completed" : null,
		notice: `${PAST[outcome]}${detail}`,
	};
	return { state, effects: done ? [{ type: "end", reason: "completed" }] : [] };
}

function onSave(s: SessionState, span: DiffSpan, spanLabel: string, lines?: string[]): Step {
	const saved = { ...s, saves: s.saves + 1 };
	const q = currentQuestion(s);
	if (!q) return { state: { ...saved, notice: `saved (${spanLabel})` }, effects: [] };
	const step = resolve(saved, q, "answered", ` (${spanLabel})`);
	return { ...step, effects: [{ type: "answer", question: q, span, lines }, ...step.effects] };
}

function onKey(s: SessionState, key: SessionKey): Step {
	if (key === "q") {
		return {
			state: { ...s, ended: "quit", notice: null },
			effects: [{ type: "end", reason: "quit" }],
		};
	}
	const q = currentQuestion(s);
	if (!q)
		return { state: { ...s, notice: "no question to act on; [q] ends the session" }, effects: [] };
	if (key === "s") return resolve(s, q, "skipped");
	if (key === "a" && !s.canDelegate) {
		return { state: { ...s, notice: "agents are off for this idea (tier 0)" }, effects: [] };
	}
	const step = resolve(s, q, KEY_OUTCOME[key]);
	const effect: SessionEffect = { type: KEY_EFFECT[key], question: q };
	return { ...step, effects: [effect, ...step.effects] };
}

function isRuleQuestion(q: QuestionRecord): boolean {
	return /^roots(:|$)/.test(q.by);
}

/** First index not yet reached: after the current question, or the end when there is none. */
function firstUnreached(s: SessionState): number {
	return currentQuestion(s) ? s.index + 1 : s.index;
}

function arriveOne(s: SessionState, q: QuestionRecord, cap: number): SessionState | null {
	if (s.questions.some((x) => x.id === q.id)) return null;
	const from = firstUnreached(s);
	let questions = s.questions;
	if (questions.length >= cap) {
		let bump = -1;
		for (let i = questions.length - 1; i >= from; i--) {
			if (isRuleQuestion(questions[i] as QuestionRecord)) {
				bump = i;
				break;
			}
		}
		if (bump === -1) return null;
		questions = questions.filter((_, i) => i !== bump);
	}
	let at = questions.length;
	for (let i = from; i < questions.length; i++) {
		if (isRuleQuestion(questions[i] as QuestionRecord)) {
			at = i;
			break;
		}
	}
	return { ...s, questions: [...questions.slice(0, at), q, ...questions.slice(at)] };
}

function onArrive(s: SessionState, incoming: readonly QuestionRecord[], cap: number): Step {
	let state = s;
	let queued = 0;
	for (const q of incoming) {
		const next = arriveOne(state, q, cap);
		if (!next) continue;
		state = next;
		queued++;
	}
	if (queued === 0) return { state: s, effects: [] };
	const notice = `an agent asked ${queued} new question${queued === 1 ? "" : "s"}`;
	return { state: { ...state, notice }, effects: [] };
}

/** Advance the session. Inputs after the end are ignored. */
export function step(s: SessionState, input: SessionInput, spanLabel = ""): Step {
	if (s.ended) return { state: s, effects: [] };
	if (input.type === "arrive") return onArrive(s, input.questions, input.cap);
	return input.type === "save"
		? onSave(s, input.span, spanLabel, input.lines)
		: onKey(s, input.key);
}

export interface SessionTally {
	answered: number;
	dismissed: number;
	snoozed: number;
	skipped: number;
	delegated: number;
	/** Questions never reached (session ended early). */
	unasked: number;
}

export function tally(s: SessionState): SessionTally {
	const t: SessionTally = {
		answered: 0,
		dismissed: 0,
		snoozed: 0,
		skipped: 0,
		delegated: 0,
		unasked: 0,
	};
	for (const q of s.questions) {
		const o = s.outcomes[q.id];
		if (o) t[o]++;
		else t.unasked++;
	}
	return t;
}

/** CSI (`ESC [ … final`), SS3 (`ESC O x`) and Alt-<key> (`ESC x`) sequences. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g;

/**
 * Map raw terminal input to session keys (Ctrl-C / Ctrl-D end the session).
 * Escape sequences are dropped first: arrow up is `ESC [ A`, not [a].
 */
export function parseKeys(data: string): SessionKey[] {
	const out: SessionKey[] = [];
	for (const ch of data.replace(ESCAPE_RE, "")) {
		const k = ch.toLowerCase();
		if (k === "d" || k === "z" || k === "s" || k === "q" || k === "a") out.push(k);
		else if (ch === "\x03" || ch === "\x04") out.push("q");
	}
	return out;
}
