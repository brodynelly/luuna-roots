// The imperative shell of a think session: prepares questions, drives the
// pure reducer (session.ts) from file saves and keys, executes its effects,
// renders the screen, and finalizes (mentions → proposals, planted →
// shaping, session.end with the content hash for verify's hash ledger).
//
// Event order for one session:
//   session.start, ask*, (answer | dismiss | snooze | delegate)*,
//   propose*/expire* (mentions, then the agent's at tier ≥ 2), status (first
//   session only), session.end, then note*/undelegate* when questions were
//   delegated with [a] (the research run, delegation.ts)
// Skips are not mutations and log nothing.
//
// Agents (tier ≥ 1, see agent-phase.ts): after session.start, agent.command
// (if configured) runs with the context packet and calls `roots ask`; those
// questions are due and come before new rule questions. During the session,
// agent questions that land in questions.jsonl (a harness calling `roots
// ask`) are queued live through the reducer's `arrive` input.

import { existsSync, readFileSync } from "node:fs";
import { lineHash } from "./blame.ts";
import type { Colors } from "./color.ts";
import type { RootsConfig } from "./config.ts";
import { findingPreview } from "./delegation.ts";
import { type ChangedLine, changedLines, type DiffSpan, diffSpan, formatSpan } from "./diff.ts";
import { claimText, readEndorsed } from "./endorse.ts";
import { NotFoundError } from "./errors.ts";
import { appendEvent, makeEvent, readEvents } from "./events.ts";
import { findNode, readGraph, updateGraph } from "./graph.ts";
import { generateId, hexSet } from "./ids.ts";
import { type MentionFiling, proposeMentions } from "./mention-scan.ts";
import type { RootsPaths } from "./paths.ts";
import { contentHash, parseProse, readNodeProse } from "./prose.ts";
import {
	addQuestions,
	answerQuestion,
	delegateQuestion,
	dismissQuestion,
	draftFromCandidate,
	dueQuestions,
	planQuestions,
	readQuestions,
	ruleContextFor,
	snoozeQuestion,
} from "./questions.ts";
import { newCandidates, ruleOf } from "./rules.ts";
import {
	currentQuestion,
	type EndReason,
	initialState,
	parseKeys,
	type SessionEffect,
	type SessionInput,
	type SessionState,
	type SessionTally,
	step,
	tally,
} from "./session.ts";
import type { StatusLine } from "./spinner.ts";
import { frame, type Terminal } from "./terminal.ts";
import {
	type BackgroundJob,
	phaseNotice,
	type SessionAgentSummary,
	type SessionDelegationSummary,
	type SessionProposalSummary,
	sessionAgentPhase,
	sessionDelegation,
	sessionProposals,
	summarizeAgent,
} from "./think-agent.ts";
import {
	renderScreen,
	type ScreenEdge,
	type ScreenFinding,
	type ScreenGuidance,
	type ScreenView,
} from "./think-screen.ts";
import { isoNow } from "./time.ts";

export type {
	BackgroundJob,
	SessionAgentSummary,
	SessionDelegationSummary,
	SessionProposalSummary,
};

import type { Actor, Graph, NodeRecord, QuestionRecord } from "./types.ts";
import { type WatchOptions, watchFile } from "./watch.ts";

export interface ThinkDeps {
	paths: RootsPaths;
	config: RootsConfig;
	node: NodeRecord;
	by: Actor;
	terminal: Terminal;
	colors: Colors;
	editorHint: string;
	watch?: WatchOptions;
	clock?: () => Date;
	/** Base environment for agent.command (the think command passes io.env). */
	env?: Record<string, string | undefined>;
	/** Status line shown while agent.command runs. */
	agentStatus?: (text: string) => StatusLine;
	/** Override config.agent.timeoutSeconds (tests). */
	agentTimeoutMs?: number;
	/** Shown on the screen for the whole session (e.g. an accepted split from `tend`). */
	guidance?: ScreenGuidance | null;
	/**
	 * Background mode (`roots flow`): agent.command runs without blocking the
	 * session (its questions arrive live) and is handed to this callback; the
	 * session-end proposal run is skipped and left to the caller, which gets
	 * the changed lines in the summary.
	 */
	background?: (job: BackgroundJob) => void;
}

export interface SessionQuestionSummary {
	id: string;
	text: string;
	by: Actor;
	outcome: string | null;
}

export interface SessionSummary {
	session: string;
	node: string;
	reason: EndReason;
	questions: SessionQuestionSummary[];
	tally: SessionTally;
	changed: boolean;
	hash: string;
	statusChange: { from: string; to: string } | null;
	mentions: MentionFiling | null;
	mentionError: string | null;
	agent: SessionAgentSummary;
	/** Session-end agent proposals (tier ≥ 2 with agent.command); null when skipped. */
	proposals: SessionProposalSummary | null;
	/** Research on questions delegated with [a] (run after session.end); null when none. */
	delegation: SessionDelegationSummary | null;
	/** Background mode only: the lines this session changed (for the caller's proposal run). */
	changedLines?: ChangedLine[];
}

export function questionSource(q: Pick<QuestionRecord, "by">): string {
	const rule = ruleOf(q);
	if (rule) return rule;
	return q.by.startsWith("agent:") ? "agent" : q.by;
}

function newSessionId(paths: RootsPaths): string {
	const taken = readEvents(paths)
		.map((e) => e.session)
		.filter((s): s is string => typeof s === "string");
	return generateId("ss", hexSet(taken));
}

function isAgentQuestion(q: Pick<QuestionRecord, "by">): boolean {
	return q.by.startsWith("agent:");
}

/**
 * Due questions first (agent questions asked just now included), then new
 * rule questions, up to questionsPerSession. With `agents: false` (tier 0)
 * queued agent questions are left out.
 */
export async function prepareQuestions(
	deps: Pick<ThinkDeps, "paths" | "config" | "node">,
	graph: Graph,
	text: string,
	session: string,
	now: Date,
	agents = true,
): Promise<QuestionRecord[]> {
	const { paths, config, node } = deps;
	const existing = readQuestions(paths);
	// roots-9699: rules judge an endorsed idea's claim, not only the thoughts.
	const claim = claimText(text, readEndorsed(paths, graph, node));
	const ctx = ruleContextFor(graph, node, claim, readEvents(paths), config, now);
	const due = dueQuestions(existing, node.id, now).filter((q) => agents || !isAgentQuestion(q));
	const plan = planQuestions(due, newCandidates(ctx, existing), config.limits.questionsPerSession);
	const drafts = plan.create.map((c) => draftFromCandidate(node.id, c));
	const created = await addQuestions(paths, drafts, { session, now });
	return [...plan.reuse, ...created];
}

function screenEdges(graph: Graph, node: NodeRecord): ScreenEdge[] {
	const out: ScreenEdge[] = [];
	for (const e of graph.edges) {
		if (e.from !== node.id && e.to !== node.id) continue;
		const direction = e.from === node.id ? "out" : "in";
		const otherId = direction === "out" ? e.to : e.from;
		out.push({ rel: e.rel, direction, id: otherId, slug: findNode(graph, otherId)?.slug ?? "?" });
	}
	return out;
}

interface Live {
	deps: ThinkDeps;
	session: string;
	state: SessionState;
	lastText: string;
	statement: string;
	edges: ScreenEdge[];
	/** Watch questions.jsonl for agent questions asked mid-session. */
	agentsLive: boolean;
	/** Question ids already considered (in the queue at start or seen since). */
	seen: Set<string>;
	/** Findings previews by question id (read once per session). */
	findings: Map<string, ScreenFinding | null>;
}

function findingFor(live: Live, q: QuestionRecord): ScreenFinding | null {
	if (!live.findings.has(q.id)) live.findings.set(q.id, findingPreview(live.deps.paths, q));
	return live.findings.get(q.id) ?? null;
}

function view(live: Live): ScreenView {
	const q = currentQuestion(live.state);
	const { node } = live.deps;
	return {
		id: node.id,
		slug: node.slug,
		status: node.status,
		statement: live.statement,
		edges: live.edges,
		question: q
			? {
					id: q.id,
					text: q.text,
					source: questionSource(q),
					index: live.state.index + 1,
					total: live.state.questions.length,
					findings: findingFor(live, q),
				}
			: null,
		canDelegate: live.state.canDelegate,
		notice: live.state.notice,
		editorHint: live.deps.editorHint,
		guidance: live.deps.guidance ?? null,
	};
}

function render(live: Live): void {
	const t = live.deps.terminal;
	t.write(frame(renderScreen(view(live), t.columns(), live.deps.colors, t.rows())));
}

async function execute(live: Live, effect: SessionEffect): Promise<void> {
	const { paths, by, config } = live.deps;
	const act = { by, session: live.session, at: (live.deps.clock ?? (() => new Date()))() };
	if (effect.type === "answer") {
		await answerQuestion(paths, effect.question.id, {
			...act,
			span: effect.span,
			lines: effect.lines,
		});
	} else if (effect.type === "dismiss") {
		await dismissQuestion(paths, effect.question.id, act);
	} else if (effect.type === "delegate") {
		await delegateQuestion(paths, effect.question.id, act);
	} else if (effect.type === "snooze") {
		await snoozeQuestion(paths, effect.question.id, { ...act, days: config.questions.snoozeDays });
	}
}

/** Run inputs through the reducer one at a time; resolves when the session ends. */
function drive(live: Live): {
	dispatch: (i: SessionInput, label?: string) => void;
	done: Promise<void>;
} {
	let chain = Promise.resolve();
	let finish: () => void = () => {};
	let fail: (e: unknown) => void = () => {};
	const done = new Promise<void>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	const handle = async (input: SessionInput, label?: string) => {
		if (live.state.ended) return;
		const r = step(live.state, input, label);
		live.state = r.state;
		for (const e of r.effects) await execute(live, e);
		if (live.state.ended) finish();
		else render(live);
	};
	const dispatch = (input: SessionInput, label?: string) => {
		chain = chain.then(() => handle(input, label)).catch(fail);
	};
	return { dispatch, done };
}

function onSave(live: Live, dispatch: (i: SessionInput, label?: string) => void, text: string) {
	const span: DiffSpan | null = diffSpan(live.lastText, text);
	const lines = changedLines(live.lastText, text).map((l) => lineHash(l.text));
	live.lastText = text;
	if (!span) return;
	live.statement = parseProse(text).statement;
	dispatch({ type: "save", span, lines }, formatSpan(span));
}

/** Open agent questions for this idea that the session has not seen yet. */
function newAgentQuestions(live: Live): QuestionRecord[] {
	const out: QuestionRecord[] = [];
	for (const q of readQuestions(live.deps.paths)) {
		if (live.seen.has(q.id)) continue;
		if (q.node !== live.deps.node.id || q.status !== "open" || !isAgentQuestion(q)) continue;
		live.seen.add(q.id);
		out.push(q);
	}
	return out;
}

function watchAgentQuestions(live: Live, dispatch: (i: SessionInput) => void) {
	if (!live.agentsLive) return null;
	const file = live.deps.paths.questions;
	const initial = existsSync(file) ? readFileSync(file, "utf8") : "";
	const cap = live.deps.config.limits.questionsPerSession;
	return watchFile(
		file,
		initial,
		() => {
			const arrived = newAgentQuestions(live);
			if (arrived.length > 0) dispatch({ type: "arrive", questions: arrived, cap });
		},
		live.deps.watch,
	);
}

async function interact(live: Live, file: string): Promise<void> {
	const { dispatch, done } = drive(live);
	const watcher = watchFile(file, live.lastText, (t) => onSave(live, dispatch, t), live.deps.watch);
	const agentWatcher = watchAgentQuestions(live, dispatch);
	try {
		live.deps.terminal.start(
			(data) => {
				for (const key of parseKeys(data)) dispatch({ type: "key", key });
			},
			() => render(live),
		);
		render(live);
		await done;
		watcher.check(); // pick up a save that raced the end key
	} finally {
		watcher.close();
		agentWatcher?.close();
		live.deps.terminal.stop();
	}
}

async function markShaping(deps: ThinkDeps, session: string, now: Date) {
	const change = await updateGraph(deps.paths, (graph) => {
		const node = findNode(graph, deps.node.id);
		if (node?.status !== "planted") return { write: false, result: null };
		node.status = "shaping";
		node.updatedAt = isoNow(now);
		return { write: true, result: { from: "planted", to: "shaping" } };
	});
	if (change) {
		await appendEvent(
			deps.paths,
			makeEvent("status", deps.by, { at: isoNow(now), node: deps.node.id, ...change, session }),
		);
	}
	return change;
}

async function fileMentions(deps: ThinkDeps, lines: ChangedLine[], now: Date) {
	try {
		if (lines.length === 0) return { mentions: null, mentionError: null };
		const graph = readGraph(deps.paths);
		const filing = await proposeMentions(deps.paths, deps.config, graph, deps.node.id, lines, now);
		return { mentions: filing, mentionError: null };
	} catch (err) {
		return { mentions: null, mentionError: err instanceof Error ? err.message : String(err) };
	}
}

async function finalize(
	live: Live,
	startText: string,
	agent: SessionAgentSummary,
): Promise<SessionSummary> {
	const { deps, session, state } = live;
	const now = (deps.clock ?? (() => new Date()))();
	const onDisk = readNodeProse(deps.paths, deps.node);
	const finalText = onDisk.exists ? onDisk.text : live.lastText;
	const hash = contentHash(finalText);
	const lines = changedLines(startText, finalText);
	const { mentions, mentionError } = await fileMentions(deps, lines, now);
	const proposals =
		deps.background || !live.agentsLive ? null : await sessionProposals(deps, session, lines);
	const statusChange = await markShaping(deps, session, now);
	const t = tally(state);
	const reason = state.ended ?? "quit";
	await appendEvent(
		deps.paths,
		makeEvent("session.end", deps.by, {
			at: isoNow(now),
			node: deps.node.id,
			session,
			hash,
			reason,
			changed: finalText !== startText,
			...t,
		}),
	);
	const delegation = await sessionDelegation(deps, session);
	return {
		session,
		node: deps.node.id,
		reason,
		questions: state.questions.map((q) => ({
			id: q.id,
			text: q.text,
			by: q.by,
			outcome: state.outcomes[q.id] ?? null,
		})),
		tally: t,
		changed: finalText !== startText,
		hash,
		statusChange,
		mentions,
		mentionError,
		agent,
		proposals,
		delegation,
		...(deps.background ? { changedLines: lines } : {}),
	};
}

/** Run one think session on `deps.node`. Resolves when the session has ended. */
export async function runThinkSession(deps: ThinkDeps): Promise<SessionSummary> {
	const now = (deps.clock ?? (() => new Date()))();
	const prose = readNodeProse(deps.paths, deps.node);
	if (!prose.exists || !prose.path) {
		throw new NotFoundError(`idea.md for ${deps.node.id} is missing`);
	}
	const session = newSessionId(deps.paths);
	await appendEvent(
		deps.paths,
		makeEvent("session.start", deps.by, { at: isoNow(now), node: deps.node.id, session }),
	);
	const graph = readGraph(deps.paths);
	const phase = await sessionAgentPhase(deps, graph, session);
	const agents = phase.mode !== "off";
	const questions = await prepareQuestions(deps, graph, prose.text, session, now, agents);
	const initial = new Set(questions.map((q) => q.id));
	const live: Live = {
		deps,
		session,
		state: { ...initialState(questions, agents), notice: phaseNotice(deps, phase) },
		lastText: prose.text,
		statement: prose.statement,
		edges: screenEdges(graph, deps.node),
		agentsLive: agents,
		seen: new Set(readQuestions(deps.paths).map((q) => q.id)),
		findings: new Map(),
	};
	await interact(live, prose.path);
	const arrived = live.state.questions.filter((q) => !initial.has(q.id)).length;
	return finalize(live, prose.text, summarizeAgent(deps, phase, session, arrived));
}
