// `luuna-roots flow`, the shell (roots-ed3c): one long session that moves from
// idea to idea without dropping to the shell. Between think sessions it
// shows the transition card (flow.ts / flow-render.ts): the trail, the
// agent's heading, running agent work, the inbox and the next pick.
//
// The agent never blocks the human here. Think sessions run in background
// mode (questions arrive live); after each session the proposal run
// (tier ≥ 2) and the heading run (flow.heading) start in the background and
// the card refreshes as their results land. Inline steps (think, tend,
// plant) are injected by the command so this file stays terminal-agnostic;
// the terminal leaves raw mode while they run.
//
// Events: flow.start at the beginning, flow.end on quit (both carry `flow`);
// everything in between is logged by the steps themselves.

import { collectAttention, rankAttention } from "./attention.ts";
import type { Colors } from "./color.ts";
import type { RootsConfig } from "./config.ts";
import { appendEvent, makeEvent, readEvents } from "./events.ts";
import {
	buildTrail,
	type FlowAction,
	type FlowCard,
	type FlowKey,
	type FlowTrail,
	flowKey,
	type HeadingView,
	initialCard,
	parseFlowKeys,
	rankPicks,
} from "./flow.ts";
import { renderFlowCard } from "./flow-render.ts";
import { findNode, readGraph } from "./graph.ts";
import { headingEnabled, runHeadingPhase } from "./heading-run.ts";
import { activeHeading, dismissHeading, newFlowId, readHeadings } from "./headings.ts";
import type { RootsPaths } from "./paths.ts";
import { scanNodeDirs } from "./prose.ts";
import { readQuestions } from "./questions.ts";
import { collectCards } from "./tend-session.ts";
import { frame, type Terminal } from "./terminal.ts";
import { type BackgroundJob, sessionProposals } from "./think-agent.ts";
import type { SessionSummary } from "./think-session.ts";
import type { Actor } from "./types.ts";

export interface FlowDeps {
	paths: RootsPaths;
	config: RootsConfig;
	by: Actor;
	terminal: Terminal;
	colors: Colors;
	env: Record<string, string | undefined>;
	clock?: () => Date;
	/** One think session in background mode (editor pane included). */
	think: (id: string, background: (job: BackgroundJob) => void) => Promise<SessionSummary>;
	/** One inline tend pass; resolves with a one-line result. */
	tend: () => Promise<string>;
	/** Plant in $EDITOR; resolves with the new idea id, or null when cancelled. */
	plant: () => Promise<string | null>;
	/** Formats a finished session for the card notice. */
	tally: (s: SessionSummary) => string;
	/** `luuna-roots flow <id>`: think about this idea first. */
	start?: string;
	/** Card refresh interval (inbox, heading, picks). Default 1000ms. */
	refreshMs?: number;
	/** Override config.agent.timeoutSeconds (tests). */
	agentTimeoutMs?: number;
}

export interface FlowSummary {
	flow: string;
	trail: FlowTrail;
	/** Agent runs still going when the human quit; resolves when they finish. */
	pending: Promise<void>;
	running: string[];
	problems: string[];
}

interface Job {
	label: string;
	heading: boolean;
}

interface Live {
	deps: FlowDeps;
	flow: string;
	startedAt: number;
	card: FlowCard;
	jobs: Map<number, Job>;
	nextJob: number;
	pending: Promise<unknown>[];
	problems: string[];
	/** Planted in this flow: offered first. */
	preferred: string | null;
	onCard: boolean;
	lastFrame: string;
	dispatch?: (data: string) => void;
}

const now = (live: Live) => (live.deps.clock ?? (() => new Date()))();

function headingView(live: Live, trail: FlowTrail): HeadingView {
	const h = activeHeading(readHeadings(live.deps.paths), live.flow);
	if (h) return { kind: "shown", heading: h };
	if ([...live.jobs.values()].some((j) => j.heading)) return { kind: "waiting" };
	if (!headingEnabled(live.deps.config) || trail.entries.length === 0) return { kind: "off" };
	return { kind: "none" };
}

/** Re-read everything the card shows. */
function refreshCard(live: Live): void {
	const { paths, config } = live.deps;
	const at = now(live);
	const graph = readGraph(paths);
	const trail = buildTrail(readEvents(paths), graph, readQuestions(paths), live.flow, at);
	const heading = headingView(live, trail);
	const ranked = rankAttention(collectAttention(paths, graph, scanNodeDirs(paths), config, at));
	const touched = new Set(trail.entries.map((e) => e.id));
	const next = heading.kind === "shown" ? heading.heading.next : undefined;
	let picks = rankPicks(ranked, touched, graph, next);
	const pref = live.preferred ? findNode(graph, live.preferred) : undefined;
	if (pref && !touched.has(pref.id)) {
		const rest = picks.filter((p) => p.id !== pref.id);
		picks = [{ id: pref.id, slug: pref.slug, reason: "just planted", fromHeading: false }, ...rest];
	}
	// Keep a pick the human chose with [o] (pick > 0); otherwise the best one leads.
	const selected = live.card.pick > 0 ? live.card.picks[live.card.pick]?.id : undefined;
	const keep = selected ? picks.findIndex((p) => p.id === selected) : -1;
	live.card = {
		...live.card,
		trail,
		heading,
		jobs: [...live.jobs.values()].map((j) => j.label),
		inbox: collectCards(paths, at).length,
		picks,
		pick: keep >= 0 ? keep : 0,
	};
}

function render(live: Live): void {
	if (!live.onCard) return;
	const t = live.deps.terminal;
	const minutes = Math.floor((now(live).getTime() - live.startedAt) / 60000);
	const lines = renderFlowCard(
		live.card,
		{ project: live.deps.config.project, minutes },
		t.columns(),
		live.deps.colors,
		t.rows(),
	);
	const text = frame(lines);
	if (text === live.lastFrame) return;
	live.lastFrame = text;
	t.write(text);
}

function refresh(live: Live): void {
	if (!live.onCard) return;
	try {
		refreshCard(live);
	} catch (err) {
		live.card = { ...live.card, notice: `refresh failed: ${String(err)}` };
	}
	render(live);
}

function track(live: Live, job: BackgroundJob, heading = false): void {
	const id = live.nextJob++;
	live.jobs.set(id, { label: job.label, heading });
	live.pending.push(
		job.done.then((problem) => {
			live.jobs.delete(id);
			if (problem) {
				live.problems.push(problem);
				live.card = { ...live.card, notice: `! ${problem} (${job.label})` };
			}
			refresh(live);
		}),
	);
}

function problemOf(run: { status: string; error: string | null } | null | undefined) {
	return run && run.status !== "ok" ? `agent.command ${run.error}` : null;
}

/** After a session: link what changed (tier ≥ 2) and refresh the heading, both in the background. */
function afterSession(live: Live, s: SessionSummary): void {
	const { deps } = live;
	const node = findNode(readGraph(deps.paths), s.node);
	const changed = s.changedLines ?? [];
	const agentDeps = {
		paths: deps.paths,
		config: deps.config,
		env: deps.env,
		agentTimeoutMs: deps.agentTimeoutMs,
	};
	if (node && changed.length > 0 && deps.config.agent.command) {
		track(live, {
			label: `linking what changed in ${node.slug}`,
			done: sessionProposals({ ...agentDeps, node }, s.session, changed).then((r) =>
				problemOf(r ? { status: r.status, error: r.error } : null),
			),
		});
	}
	if (!headingEnabled(deps.config)) return;
	const trail = buildTrail(
		readEvents(deps.paths),
		readGraph(deps.paths),
		readQuestions(deps.paths),
		live.flow,
		now(live),
	);
	track(
		live,
		{
			label: "reading the session for a heading",
			done: runHeadingPhase({
				paths: deps.paths,
				config: deps.config,
				flow: live.flow,
				trail,
				env: deps.env,
				timeoutMs: deps.agentTimeoutMs,
			}).then((r) => problemOf(r?.run)),
		},
		true,
	);
}

/** Leave the card (raw mode off) for an inline step, then come back to it. */
async function handOff<T>(live: Live, fn: () => Promise<T>): Promise<T> {
	live.onCard = false;
	live.deps.terminal.stop();
	try {
		return await fn();
	} finally {
		live.onCard = true;
		live.lastFrame = "";
		live.deps.terminal.start(
			(data) => live.dispatch?.(data),
			() => {
				live.lastFrame = "";
				render(live);
			},
		);
		refresh(live);
	}
}

async function think(live: Live, id: string): Promise<void> {
	const s = await handOff(live, () => live.deps.think(id, (job) => track(live, job)));
	if (live.preferred === id) live.preferred = null;
	const slug = findNode(readGraph(live.deps.paths), id)?.slug ?? id;
	live.card = { ...live.card, notice: `${slug} done · ${live.deps.tally(s)}` };
	afterSession(live, s);
	refresh(live);
}

async function perform(live: Live, action: FlowAction): Promise<void> {
	const { deps } = live;
	// A step changes what is worth doing next: forget an [o] selection.
	if (action.type !== "dismiss") live.card = { ...live.card, pick: 0, picks: [] };
	if (action.type === "think") return think(live, action.id);
	if (action.type === "tend") {
		const result = await handOff(live, () => deps.tend());
		live.card = { ...live.card, notice: result };
	} else if (action.type === "plant") {
		const id = await handOff(live, () => deps.plant());
		live.preferred = id ?? live.preferred;
		live.card = { ...live.card, notice: id ? `planted ${id}` : "nothing planted" };
	} else if (action.type === "dismiss") {
		await dismissHeading(deps.paths, action.heading, deps.by, now(live));
		live.card = { ...live.card, notice: "heading dismissed; the agent won't say it again" };
	}
	refresh(live);
}

function stepError(live: Live, err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err);
	live.card = { ...live.card, notice: `! ${msg}` };
	refresh(live);
}

async function onKey(live: Live, key: FlowKey, quit: () => void): Promise<void> {
	const r = flowKey(live.card, key);
	live.card = r.card;
	if (r.action?.type === "quit") return quit();
	if (!r.action) return render(live);
	await perform(live, r.action).catch((err) => stepError(live, err));
}

/** Feed keys through the reducer one at a time; resolves when the human quits. */
function drive(live: Live): Promise<void> {
	let chain = Promise.resolve();
	return new Promise<void>((resolve) => {
		const handle = async (data: string) => {
			for (const key of parseFlowKeys(data)) {
				if (live.card.ended) return;
				await onKey(live, key, resolve);
			}
		};
		live.dispatch = (data) => {
			chain = chain.then(() => handle(data));
		};
	});
}

export async function runFlow(deps: FlowDeps): Promise<FlowSummary> {
	const flow = newFlowId(deps.paths);
	const clock = deps.clock ?? (() => new Date());
	await appendEvent(deps.paths, makeEvent("flow.start", deps.by, { flow }));
	const live: Live = {
		deps,
		flow,
		startedAt: clock().getTime(),
		card: initialCard(),
		jobs: new Map(),
		nextJob: 0,
		pending: [],
		problems: [],
		preferred: null,
		onCard: true,
		lastFrame: "",
	};
	const done = drive(live);
	const timer = setInterval(() => refresh(live), deps.refreshMs ?? 1000);
	try {
		deps.terminal.start(
			(data) => live.dispatch?.(data),
			() => {
				live.lastFrame = "";
				render(live);
			},
		);
		refresh(live);
		if (deps.start) await think(live, deps.start).catch((err) => stepError(live, err));
		await done;
	} finally {
		clearInterval(timer);
		live.onCard = false;
		deps.terminal.stop();
		await appendEvent(deps.paths, makeEvent("flow.end", deps.by, { flow }));
	}
	const graph = readGraph(deps.paths);
	const trail = buildTrail(readEvents(deps.paths), graph, readQuestions(deps.paths), flow, clock());
	return {
		flow,
		trail,
		pending: Promise.all(live.pending).then(() => undefined),
		running: [...live.jobs.values()].map((j) => j.label),
		problems: live.problems,
	};
}
