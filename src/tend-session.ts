// `roots tend`, the shell: expire overdue proposals and sprouts, collect
// cards, drive the pure reducer (tend.ts) from keys, execute decisions
// through decide.ts, and hand off to the human's editor when needed: an
// accepted split opens a think session (with the proposal shown as guidance),
// an adopted sprout opens the adopt flow (AdoptRunner); [t] thoughts endorse
// the sprout in place (adopt.ts endorse) or via the editor. The terminal leaves
// raw mode for the hand-off and comes back to the next card.

import { relative } from "node:path";
import { completeAdoption } from "./adopt.ts";
import type { Colors } from "./color.ts";
import { acceptItem, type Decision, rejectItem } from "./decide.ts";
import { CancelledError } from "./errors.ts";
import { findNode, readGraph } from "./graph.ts";
import type { RootsPaths } from "./paths.ts";
import { expireProposals, pendingProposals, readProposals } from "./proposals.ts";
import { readNodeProse } from "./prose.ts";
import { sproutDecision } from "./sprout-decide.ts";
import { expireSprouts, openSprouts } from "./sprouts.ts";
import {
	type CardNode,
	initialTend,
	proposalCards,
	sortCards,
	sproutCard,
	type TendAction,
	type TendCard,
	type TendEffect,
	type TendInput,
	type TendOutcome,
	type TendState,
	type TendTally,
	tendStep,
	tendTally,
} from "./tend.ts";
import { renderTend } from "./tend-render.ts";
import { frame, type Terminal } from "./terminal.ts";
import type { Actor, Graph, NodeRecord, ProposalRecord } from "./types.ts";

/** Runs a think session on `node` with guidance; resolves with a one-line result. */
export type ThinkRunner = (node: string, guidance: string) => Promise<string>;

/**
 * Adopts a sprout interactively (commands/adopt.ts runAdoption): the human
 * writes the idea in $EDITOR. With `endorse` (their thoughts so far), it
 * endorses instead and the editor opens on those thoughts. Throws
 * CancelledError on an empty save.
 */
export type AdoptRunner = (sproutId: string, endorse?: string) => Promise<Decision>;

export interface TendDeps {
	paths: RootsPaths;
	by: Actor;
	terminal: Terminal;
	colors: Colors;
	clock?: () => Date;
	think?: ThinkRunner;
	adopt?: AdoptRunner;
}

export interface TendSummary {
	expired: ProposalRecord[];
	expiredSprouts: NodeRecord[];
	cards: number;
	tally: TendTally;
	decisions: Decision[];
}

function nodeLookup(graph: Graph): (id: string) => CardNode {
	return (id) => ({ id, slug: findNode(graph, id)?.slug ?? id });
}

function sproutCards(paths: RootsPaths, graph: Graph, now: Date): TendCard[] {
	return openSprouts(graph, now).map((n) => {
		const prose = readNodeProse(paths, n);
		return sproutCard({ ...n, statement: prose.statement, body: prose.body });
	});
}

/** Every card to review: pending proposals and open sprouts, soonest expiry first. */
export function collectCards(paths: RootsPaths, now: Date): TendCard[] {
	const graph = readGraph(paths);
	const proposals = proposalCards(
		pendingProposals(readProposals(paths), now, graph),
		nodeLookup(graph),
	);
	return sortCards([...proposals, ...sproutCards(paths, graph, now)]);
}

interface Live {
	deps: TendDeps;
	state: TendState;
	expired: number;
	expiredSprouts: number;
	decisions: Decision[];
	dispatch?: (input: TendInput) => void;
}

function render(live: Live): void {
	const t = live.deps.terminal;
	const now = (live.deps.clock ?? (() => new Date()))();
	const view = {
		state: live.state,
		now,
		expired: live.expired,
		expiredSprouts: live.expiredSprouts,
	};
	t.write(frame(renderTend(view, t.columns(), live.deps.colors, t.rows())));
}

/** Leave raw mode while the human is in their editor, then come back. */
async function handOff<T>(live: Live, fn: () => Promise<T>): Promise<T> {
	const t = live.deps.terminal;
	t.stop();
	try {
		return await fn();
	} finally {
		t.start(
			(data) => live.dispatch?.({ type: "data", data }),
			() => render(live),
		);
	}
}

/** [t]: typed thoughts endorse right away; ctrl-e hands off to the editor. */
async function endorse(live: Live, id: string, text: string, editor: boolean): Promise<Decision> {
	const { paths, by } = live.deps;
	const runner = live.deps.adopt;
	if (editor) {
		if (!runner) throw new Error("no editor hand-off here; press enter to endorse");
		return handOff(live, () => runner(id, text === "" ? "" : `${text}\n`));
	}
	const r = await completeAdoption(paths, { sprout: id, text: `${text}\n`, by, endorse: true });
	const d = sproutDecision(id, "accept", r.sprout, r.idea, relative(paths.root, r.file));
	d.edge = r.edge;
	return d;
}

async function decide(live: Live, card: TendCard, action: TendAction): Promise<Decision> {
	const now = (live.deps.clock ?? (() => new Date()))();
	const runner = live.deps.adopt;
	const adopt = runner ? (id: string) => handOff(live, () => runner(id)) : undefined;
	const ctx = { paths: live.deps.paths, by: live.deps.by, now, adopt };
	if (action.type === "reject") return rejectItem(ctx, card.id, action.reason);
	if (action.type === "endorse") return endorse(live, card.id, action.text, action.editor);
	if (action.type !== "accept") throw new Error(`nothing to decide for ${action.type}`);
	return acceptItem(ctx, card.id, { rel: action.rel, keep: action.keep });
}

async function thinkAfterSplit(live: Live, d: Decision): Promise<string | undefined> {
	const runner = live.deps.think;
	if (!d.think) return undefined;
	if (!runner) return `split accepted; run \`roots think ${d.think.node}\` to do it`;
	const { node, guidance } = d.think;
	return handOff(live, () => runner(node, guidance));
}

function outcomeOf(d: Decision): TendOutcome {
	return d.action === "accept" ? "accepted" : "rejected";
}

function noticeOf(d: Decision): string {
	const s = d.sprout;
	if (s?.idea?.endorses) return `${s.node.id} endorsed as ${s.idea.id} ${s.idea.slug}`;
	if (s?.idea) return `${s.node.id} adopted as ${s.idea.id} ${s.idea.slug}`;
	if (s) return `${s.node.id} ${s.node.status}`;
	if (d.edge) return `${d.edge.id}: ${d.edge.from} ${d.edge.rel} ${d.edge.to}`;
	const composted = d.statusChanges.map((s) => `${s.node} composted`).join(", ");
	return composted || `${d.id} ${outcomeOf(d)}`;
}

async function execute(live: Live, effect: TendEffect): Promise<TendInput> {
	try {
		const d = await decide(live, effect.card, effect.action);
		live.decisions.push(d);
		const thought = await thinkAfterSplit(live, d);
		return { type: "done", ok: true, outcome: outcomeOf(d), notice: thought ?? noticeOf(d) };
	} catch (err) {
		if (err instanceof CancelledError) {
			return {
				type: "done",
				ok: true,
				outcome: "skipped",
				notice: "adoption cancelled; nothing written",
			};
		}
		return { type: "done", ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function drive(live: Live): Promise<void> {
	let chain = Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const handle = async (input: TendInput) => {
			if (live.state.ended) return;
			const r = tendStep(live.state, input);
			live.state = r.state;
			for (const e of r.effects) {
				render(live); // shows "working…"
				const result = await execute(live, e);
				live.state = tendStep(live.state, result).state;
			}
			if (live.state.ended) resolve();
			else render(live);
		};
		live.dispatch = (input) => {
			chain = chain.then(() => handle(input)).catch(reject);
		};
	});
}

/** Run one tend pass. Resolves when every card is decided or the human quits. */
export async function runTend(deps: TendDeps): Promise<TendSummary> {
	const now = (deps.clock ?? (() => new Date()))();
	const expired = await expireProposals(deps.paths, now);
	const expiredSprouts = await expireSprouts(deps.paths, now);
	const cards = collectCards(deps.paths, now);
	const live: Live = {
		deps,
		state: initialTend(cards),
		expired: expired.length,
		expiredSprouts: expiredSprouts.length,
		decisions: [],
	};
	if (cards.length > 0) {
		const done = drive(live);
		try {
			deps.terminal.start(
				(data) => live.dispatch?.({ type: "data", data }),
				() => render(live),
			);
			render(live);
			await done;
		} finally {
			deps.terminal.stop();
		}
	}
	return {
		expired,
		expiredSprouts,
		cards: cards.length,
		tally: tendTally(live.state),
		decisions: live.decisions,
	};
}
