// What needs thinking: per-idea open questions and rule candidates, ranked.
// Used by `roots think` (no id) to pick an idea and by `roots queue`.
//
// Queue order (first = most in need):
//   1. ideas with due questions (asked before, still open, or snoozed and
//      due again) before ideas with only new rule candidates
//   1b. among those, ideas where agent findings came back ([a] in think)
//   2. more pending work (due + candidates) first
//   3. planted before shaping before committed (young ideas need shape)
//   4. least recently touched by a human first
//   5. id, for a stable order
// Only planted/shaping/committed ideas are queued; built and composted
// ideas never come up on their own (`roots think <id>` still works for built).

import type { RootsConfig } from "./config.ts";
import { readClaim } from "./endorse.ts";
import { readEvents } from "./events.ts";
import type { RootsPaths } from "./paths.ts";
import type { NodeDirs } from "./prose.ts";
import {
	dueQuestions,
	hasFindings,
	type NodeActivity,
	nodeActivity,
	readQuestions,
	ruleContextFor,
} from "./questions.ts";
import { newCandidates, type RuleCandidate } from "./rules.ts";
import type { Graph, NodeRecord, NodeStatus, QuestionRecord } from "./types.ts";

export interface IdeaAttention {
	node: NodeRecord;
	statement: string;
	due: QuestionRecord[];
	candidates: RuleCandidate[];
	activity: NodeActivity;
}

const STATUS_RANK: Partial<Record<NodeStatus, number>> = { planted: 0, shaping: 1, committed: 2 };

export function isQueueable(node: NodeRecord): boolean {
	return node.kind === "idea" && STATUS_RANK[node.status] !== undefined;
}

export function needs(a: IdeaAttention): number {
	return a.due.length + a.candidates.length;
}

/** Due questions whose delegated research came back. */
export function findingsReady(a: Pick<IdeaAttention, "due">): number {
	return a.due.filter(hasFindings).length;
}

export function compareAttention(a: IdeaAttention, b: IdeaAttention): number {
	const hasDue = Number(b.due.length > 0) - Number(a.due.length > 0);
	if (hasDue !== 0) return hasDue;
	const found = Number(findingsReady(b) > 0) - Number(findingsReady(a) > 0);
	if (found !== 0) return found;
	if (needs(a) !== needs(b)) return needs(b) - needs(a);
	const rank = (STATUS_RANK[a.node.status] ?? 9) - (STATUS_RANK[b.node.status] ?? 9);
	if (rank !== 0) return rank;
	const touched = a.activity.lastTouched.localeCompare(b.activity.lastTouched);
	return touched !== 0 ? touched : a.node.id.localeCompare(b.node.id);
}

/** Queueable ideas with something to ask, most in need first. */
export function rankAttention(list: readonly IdeaAttention[]): IdeaAttention[] {
	return list.filter((a) => isQueueable(a.node) && needs(a) > 0).sort(compareAttention);
}

export function collectAttention(
	paths: RootsPaths,
	graph: Graph,
	dirs: NodeDirs,
	config: RootsConfig,
	now: Date,
): IdeaAttention[] {
	const questions = readQuestions(paths);
	const events = readEvents(paths);
	const out: IdeaAttention[] = [];
	for (const node of graph.nodes) {
		if (!isQueueable(node)) continue;
		const { prose, statement, text } = readClaim(paths, graph, node, dirs);
		const ctx = ruleContextFor(graph, node, text, events, config, now);
		out.push({
			node,
			statement,
			due: dueQuestions(questions, node.id, now),
			candidates: prose.exists ? newCandidates(ctx, questions) : [],
			activity: nodeActivity(events, node),
		});
	}
	return out;
}
