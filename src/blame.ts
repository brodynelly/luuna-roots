// Which question each line of idea.md answered (`luuna-roots blame`). Pure.
//
// When a think save answers a question, the `answer` event stores a short
// hash of every line the save added (`lines`, from changedLines()). Hashes,
// not text: human prose is never cached in JSONL (AGENTS.md invariant 3).
// Blame hashes the current file and matches each line to the most recent
// answer that added it. Content, not line numbers, so it survives edits
// elsewhere in the file. A line edited after its answer no longer matches
// and shows as unattributed; a later answer that rewrites it takes it over.
//
// Answers recorded before `lines` existed have only a span (line numbers at
// save time). When idea.md is byte-identical to the end of that answer's
// session (session.end hash), the session's spans are replayed in order to
// map them onto today's lines (spanLines). Otherwise they stay untracked.

import { createHash } from "node:crypto";
import type { DiffSpan } from "./diff.ts";
import { splitLines } from "./diff.ts";
import { contentHash } from "./prose.ts";
import type { EventRecord, QuestionRecord } from "./types.ts";

/** 12-hex hash of a line, ignoring leading/trailing whitespace. */
export function lineHash(text: string): string {
	return createHash("sha256").update(text.trim()).digest("hex").slice(0, 12);
}

export interface BlameLine {
	/** 1-based line number. */
	n: number;
	text: string;
	/** The question this line answered, or null. */
	question: string | null;
}

export interface BlameAnswer {
	question: string;
	text: string;
	askedBy: string;
	answeredBy: string;
	at: string;
	session: string | null;
	/** Lines of the current file attributed to this answer. */
	lines: number;
	/** How it was placed: line hashes, replayed span (older answers), or not at all. */
	placed: "lines" | "span" | "none";
}

export interface Blame {
	lines: BlameLine[];
	/** Every answer to this idea, oldest first. */
	answers: BlameAnswer[];
	/** Older answers without line hashes that could not be placed. */
	untracked: number;
}

function spanOf(e: EventRecord): DiffSpan | null {
	const s = e.span as Partial<DiffSpan> | undefined;
	if (typeof s?.from !== "number" || typeof s.to !== "number" || typeof s.removed !== "number") {
		return null;
	}
	return { from: s.from, to: s.to, removed: s.removed };
}

/** Where line `n` ends up after `span` is applied: [] when the span replaced it. */
function shifted(n: number, span: DiffSpan): number[] {
	if (n < span.from) return [n];
	const oldEnd = span.from + span.removed - 1;
	return n > oldEnd ? [n + span.to - span.from + 1 - span.removed] : [];
}

/**
 * Replay one session's answer spans (in save order) to the line numbers they
 * cover at session end. A later span deletes the old lines it replaced and
 * shifts everything below it. Later answers win overlapping lines.
 */
export function spanLines(answers: ReadonlyArray<{ question: string; span: DiffSpan }>) {
	const placed: Array<{ question: string; lines: number[] }> = [];
	for (const { question, span } of answers) {
		for (const p of placed) p.lines = p.lines.flatMap((n) => shifted(n, span));
		const own = Array.from(
			{ length: Math.max(0, span.to - span.from + 1) },
			(_, i) => span.from + i,
		);
		placed.push({ question, lines: own });
	}
	const owner = new Map<number, string>();
	for (const p of placed) for (const n of p.lines) owner.set(n, p.question);
	return owner;
}

function hashesOf(e: EventRecord): string[] | null {
	if (!Array.isArray(e.lines)) return null;
	return e.lines.filter((h): h is string => typeof h === "string");
}

type SessionSpans = Map<string, Array<{ question: string; span: DiffSpan }>>;

/** Place one answer: by its line hashes, else by its span when its session is intact. */
function place(
	e: EventRecord & { question: string },
	owner: Map<string, string>,
	bySession: SessionSpans,
	intact: ReadonlySet<unknown>,
): BlameAnswer["placed"] {
	const hashes = hashesOf(e);
	if (hashes) {
		for (const h of hashes) owner.set(h, e.question);
		return "lines";
	}
	const span = spanOf(e);
	const session = typeof e.session === "string" ? e.session : null;
	if (!span || !session || !intact.has(session)) return "none";
	bySession.set(session, [...(bySession.get(session) ?? []), { question: e.question, span }]);
	return "span";
}

export function buildBlame(
	node: string,
	text: string,
	events: readonly EventRecord[],
	questions: readonly QuestionRecord[],
): Blame {
	const owner = new Map<string, string>();
	const answers: BlameAnswer[] = [];
	const bySession: SessionSpans = new Map();
	const hash = contentHash(text);
	const intact = new Set(
		events
			.filter((e) => e.type === "session.end" && e.node === node && e.hash === hash)
			.map((e) => e.session),
	);
	for (const e of events) {
		if (e.type !== "answer" || e.node !== node || typeof e.question !== "string") continue;
		const q = questions.find((r) => r.id === e.question);
		answers.push({
			question: e.question,
			text: q?.text ?? "(question not found)",
			askedBy: q?.by ?? "unknown",
			answeredBy: e.by,
			at: e.at,
			session: typeof e.session === "string" ? e.session : null,
			lines: 0,
			placed: place({ ...e, question: e.question }, owner, bySession, intact),
		});
	}
	const byLine = new Map<number, string>();
	for (const list of bySession.values()) for (const [n, q] of spanLines(list)) byLine.set(n, q);
	const lines = splitLines(text).map((t, i) => {
		const blank = t.trim() === "";
		const question = blank ? null : (owner.get(lineHash(t)) ?? byLine.get(i + 1) ?? null);
		return { n: i + 1, text: t, question };
	});
	for (const a of answers) a.lines = lines.filter((l) => l.question === a.question).length;
	const untracked = answers.filter((a) => a.placed === "none").length;
	return { lines, answers, untracked };
}

export interface AnswerBlock {
	/** The question these lines answered, or null. */
	question: string | null;
	text: string;
}

/**
 * The body (everything after the statement line) split into runs of lines
 * that answered the same question. Blank lines stay with the run above them,
 * so paragraph breaks do not start a new block. For `luuna-roots view`.
 */
export function answerBlocks(b: Blame): AnswerBlock[] {
	const start = b.lines.findIndex((l) => l.text.trim() !== "");
	const blocks: Array<{ question: string | null; lines: string[] }> = [];
	let cur: { question: string | null; lines: string[] } | null = null;
	for (const l of start === -1 ? [] : b.lines.slice(start + 1)) {
		const blank = l.text.trim() === "";
		if (blank && !cur) continue;
		if (!cur || (!blank && l.question !== cur.question)) {
			cur = { question: l.question, lines: [] };
			blocks.push(cur);
		}
		cur.lines.push(l.text);
	}
	return blocks.map((x) => ({ question: x.question, text: x.lines.join("\n").trimEnd() }));
}
