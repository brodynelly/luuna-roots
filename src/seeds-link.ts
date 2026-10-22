// Seeds integration (roots-4689). Read-only: roots reads
// <project>/.luuna/missions/issues.jsonl directly (no `sd` process, no dependency on
// seeds) and never writes to .luuna/missions/.
//
// Reading follows seeds' own rule: JSONL, dedup by id, last occurrence wins.
// Unknown fields are ignored; malformed lines are skipped; no .luuna/missions/ means
// no issues.
//
// Linking an issue to an idea, in order of precedence:
//   1. `intent` field (the future `sd create --intent r-a1b2`; a string or a
//      string[]). Also read from `extensions.intent`, where seeds keeps
//      fields it does not know yet. When an issue has an intent field, it is
//      authoritative: the issue links to exactly those ideas, and r- ids in
//      its text are plain references, not links.
//   2. Otherwise, an exact `r-xxxx` token (see idea-refs.ts) in the title,
//      description or labels links the issue to that idea.
//
// Only a human changes status (invariant 5): when every issue linked to a
// committed idea is closed, `luuna-roots queue` *prompts* `luuna-roots status <id>
// built`. Nothing here changes an idea.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { citedIdeaIds } from "./idea-refs.ts";
import { dedupById, readJsonlFile } from "./store.ts";
import type { Graph, NodeRecord } from "./types.ts";

export const SEEDS_DIR = ".luuna/missions";

export type LinkVia = "intent" | "mention";

export interface SeedsIssue {
	id: string;
	title: string;
	status: string;
	type?: string;
	priority?: number;
	description?: string;
	labels?: string[];
	closedAt?: string;
	intent?: unknown;
	extensions?: unknown;
}

export interface LinkedIssue {
	id: string;
	title: string;
	status: string;
	closed: boolean;
	via: LinkVia;
}

export function seedsPresent(root: string): boolean {
	return existsSync(join(root, SEEDS_DIR));
}

function isIssue(v: Record<string, unknown>): boolean {
	return typeof v.id === "string" && v.id !== "";
}

/** All issues in <root>/.luuna/missions/issues.jsonl (dedup, last wins); [] when absent. */
export function readSeedsIssues(root: string): SeedsIssue[] {
	const rows = readJsonlFile<Record<string, unknown>>(join(root, SEEDS_DIR, "issues.jsonl"));
	return dedupById(rows.filter(isIssue) as { id: string }[]).map((r) => {
		const v = r as Record<string, unknown>;
		return {
			...(v as unknown as SeedsIssue),
			title: typeof v.title === "string" ? v.title : "",
			status: typeof v.status === "string" ? v.status : "open",
		};
	});
}

function intentList(v: unknown): string[] | null {
	if (typeof v === "string") return citedIdeaIds(v);
	if (Array.isArray(v)) return v.filter((x) => typeof x === "string").flatMap(citedIdeaIds);
	return null;
}

function explicitIntent(issue: SeedsIssue): string[] | null {
	const direct = intentList(issue.intent);
	if (direct !== null) return direct;
	const ext = issue.extensions;
	if (typeof ext === "object" && ext !== null && !Array.isArray(ext)) {
		return intentList((ext as Record<string, unknown>).intent);
	}
	return null;
}

function issueText(issue: SeedsIssue): string {
	const labels = Array.isArray(issue.labels)
		? issue.labels.filter((l) => typeof l === "string")
		: [];
	return [
		issue.title,
		typeof issue.description === "string" ? issue.description : "",
		...labels,
	].join("\n");
}

/** Ideas an issue links to, and how. */
export function issueLinks(issue: SeedsIssue): { ids: string[]; via: LinkVia } {
	const intent = explicitIntent(issue);
	if (intent !== null) return { ids: intent, via: "intent" };
	return { ids: citedIdeaIds(issueText(issue)), via: "mention" };
}

export function isClosed(issue: Pick<SeedsIssue, "status">): boolean {
	return issue.status === "closed";
}

/** Issues linked to `ideaId`, in file order. */
export function linkedIssues(issues: readonly SeedsIssue[], ideaId: string): LinkedIssue[] {
	const out: LinkedIssue[] = [];
	for (const issue of issues) {
		const { ids, via } = issueLinks(issue);
		if (!ids.includes(ideaId)) continue;
		out.push({
			id: issue.id,
			title: issue.title,
			status: issue.status,
			closed: isClosed(issue),
			via,
		});
	}
	return out;
}

export interface ReadyToBuild {
	node: NodeRecord;
	issues: LinkedIssue[];
}

/** Committed ideas with at least one linked issue, all of them closed. */
export function readyToMarkBuilt(graph: Graph, issues: readonly SeedsIssue[]): ReadyToBuild[] {
	if (issues.length === 0) return [];
	const out: ReadyToBuild[] = [];
	for (const node of graph.nodes) {
		if (node.kind !== "idea" || node.status !== "committed") continue;
		const linked = linkedIssues(issues, node.id);
		if (linked.length > 0 && linked.every((i) => i.closed)) out.push({ node, issues: linked });
	}
	return out;
}
