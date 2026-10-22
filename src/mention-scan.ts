// Turn mentions in changed lines into `edge` proposals (rel: null, by
// roots:mention). Shared by the end of a `think` session and `luuna-roots scan`.
// Each proposal cites the human's mentioning line plus the target's
// statement, so the human's own words are the evidence.

import type { RootsConfig } from "./config.ts";
import type { ChangedLine } from "./diff.ts";
import { readClaim } from "./endorse.ts";
import { findMentions, type Mention, type MentionTarget } from "./mentions.ts";
import type { RootsPaths } from "./paths.ts";
import { type FileResult, fileProposals, MENTION_ACTOR, type ProposalDraft } from "./proposals.ts";
import type { NodeDirs } from "./prose.ts";
import type { Graph } from "./types.ts";

/** Live ideas with a statement on disk. */
export function mentionTargets(paths: RootsPaths, graph: Graph, dirs?: NodeDirs): MentionTarget[] {
	const out: MentionTarget[] = [];
	for (const n of graph.nodes) {
		if (n.kind !== "idea" || n.status === "composted") continue;
		const { statement } = readClaim(paths, graph, n, dirs);
		if (statement !== "") out.push({ id: n.id, slug: n.slug, statement });
	}
	return out;
}

export function mentionDrafts(
	from: string,
	mentions: readonly Mention[],
	targets: readonly MentionTarget[],
): ProposalDraft[] {
	const drafts: ProposalDraft[] = [];
	for (const m of mentions) {
		const t = targets.find((x) => x.id === m.target);
		if (!t) continue;
		drafts.push({
			kind: "edge",
			from,
			to: t.id,
			rel: null,
			reason: `mentions ${t.slug} (${m.via}: "${m.match}")`,
			cites: [
				{ node: from, quote: m.text.trim() },
				{ node: t.id, quote: t.statement },
			],
			by: MENTION_ACTOR,
		});
	}
	return drafts;
}

export interface MentionFiling {
	mentions: Mention[];
	result: FileResult;
}

export async function proposeMentions(
	paths: RootsPaths,
	config: RootsConfig,
	graph: Graph,
	from: string,
	lines: readonly ChangedLine[],
	now = new Date(),
): Promise<MentionFiling> {
	const targets = mentionTargets(paths, graph);
	const mentions = findMentions(lines, targets, from);
	const empty: FileResult = { filed: [], skipped: [], expired: [], expiredWhy: [] };
	if (mentions.length === 0) return { mentions, result: empty };
	const result = await fileProposals(paths, mentionDrafts(from, mentions, targets), {
		cap: config.limits.proposals,
		ttlDays: config.limits.proposalTtlDays,
		now,
	});
	return { mentions, result };
}
