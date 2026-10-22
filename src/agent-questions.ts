// Agent questions (`luuna-roots ask`, tier ≥ 1). Every agent write is validated
// (AGENTS.md invariant 4) before it reaches questions.jsonl:
//
//   - the actor is an agent (checked by the command via resolveAgentActor)
//   - the target is a live idea (not a sprout, not composted)
//   - effective tier ≥ 1 (per-idea override, else config)
//   - one line, non-empty, ends with "?", ≤ QUESTION_MAX_LENGTH characters
//   - cap: open + snoozed agent questions on the idea < limits.questionsPerSession
//   - not a duplicate (normalized text) of an open, snoozed or dismissed question
//     on the idea; dismissals are permanent memory
//
// Writes go through addQuestions (one `ask` event each). Nothing here
// touches .luuna/roots/human/.

import { loadConfig, type RootsConfig } from "./config.ts";
import { openAgentQuestions, QUESTION_MAX_LENGTH } from "./context.ts";
import { GuardError, UsageError, ValidationError } from "./errors.ts";
import { readEvents } from "./events.ts";
import type { RootsPaths } from "./paths.ts";
import { addQuestions, readQuestions } from "./questions.ts";
import { requireTier } from "./tier.ts";
import type { Actor, NodeRecord, QuestionRecord } from "./types.ts";

/** Collapse whitespace; the stored form of a question. */
export function cleanQuestion(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Comparison key: case, punctuation and spacing do not make a question new. */
export function questionFingerprint(text: string): string {
	return cleanQuestion(text)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

const BLOCKING: ReadonlySet<QuestionRecord["status"]> = new Set(["open", "snoozed", "dismissed"]);

/** An existing question on the node that makes `text` a duplicate, if any. */
export function findDuplicateQuestion(
	rows: readonly QuestionRecord[],
	node: string,
	text: string,
): QuestionRecord | undefined {
	const key = questionFingerprint(text);
	return rows.find(
		(q) => q.node === node && BLOCKING.has(q.status) && questionFingerprint(q.text) === key,
	);
}

export function checkQuestionText(raw: string): string {
	const text = cleanQuestion(raw);
	if (text === "") throw new UsageError("the question is empty");
	if (text.length > QUESTION_MAX_LENGTH) {
		throw new ValidationError(
			`question is ${text.length} characters; the limit is ${QUESTION_MAX_LENGTH}. Ask one specific thing`,
		);
	}
	if (!text.endsWith("?")) throw new ValidationError('a question must end with "?"');
	return text;
}

function checkTarget(node: NodeRecord): void {
	if (node.kind !== "idea") {
		throw new ValidationError(`${node.id} is a sprout; questions are asked about human ideas`);
	}
	if (node.status === "composted") {
		throw new ValidationError(`${node.id} is composted; there is nothing left to ask about`);
	}
}

function checkCap(rows: readonly QuestionRecord[], node: NodeRecord, config: RootsConfig): void {
	const cap = config.limits.questionsPerSession;
	const open = openAgentQuestions(rows, node.id).length;
	if (open >= cap) {
		throw new ValidationError(
			`${node.id} already has ${open} open agent question${open === 1 ? "" : "s"} ` +
				`(limit ${cap}, limits.questionsPerSession); wait for the human to answer or dismiss them`,
			{ open, cap },
		);
	}
}

function checkDuplicate(rows: readonly QuestionRecord[], node: NodeRecord, text: string): void {
	const dup = findDuplicateQuestion(rows, node.id, text);
	if (!dup) return;
	const why =
		dup.status === "dismissed"
			? "the human dismissed it; do not ask it again"
			: `it is ${dup.status}`;
	throw new ValidationError(`duplicate of ${dup.id} ("${dup.text}"): ${why}`, {
		duplicate: dup.id,
	});
}

/**
 * The session to attach the question to: a think session on this node that
 * has started and not ended. Anything else is ignored (not an error), so a
 * stale ROOTS_SESSION never blocks an ask.
 */
export function liveSession(paths: RootsPaths, node: string, session: string | undefined) {
	if (!session) return undefined;
	let started = false;
	for (const e of readEvents(paths)) {
		if (e.session !== session || e.node !== node) continue;
		if (e.type === "session.start") started = true;
		if (e.type === "session.end") return undefined;
	}
	return started ? session : undefined;
}

export interface AskInput {
	node: NodeRecord;
	text: string;
	by: Actor;
	session?: string;
	now?: Date;
}

export interface AskResult {
	question: QuestionRecord;
	session: string | null;
}

/** Validate and record one agent question. Throws on any failed check. */
export async function askAgentQuestion(paths: RootsPaths, input: AskInput): Promise<AskResult> {
	if (!input.by.startsWith("agent:")) throw new GuardError("only agents ask questions");
	const config = loadConfig(paths);
	checkTarget(input.node);
	requireTier(config, 1, "`luuna-roots ask`", input.node);
	const text = checkQuestionText(input.text);
	const validate = (rows: readonly QuestionRecord[]) => {
		checkCap(rows, input.node, config);
		checkDuplicate(rows, input.node, text);
	};
	validate(readQuestions(paths)); // fail fast, before resolving the session
	const session = liveSession(paths, input.node.id, input.session);
	const [question] = await addQuestions(paths, [{ node: input.node.id, text, by: input.by }], {
		session,
		now: input.now,
		validate,
	});
	if (!question) throw new Error("question was not recorded");
	return { question, session: session ?? null };
}
