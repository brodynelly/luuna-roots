// Agent proposals (`roots propose`, tier ≥ 2). Every agent write is validated
// (AGENTS.md invariant 4) before it reaches proposals.jsonl:
//
//   - the actor is an agent (checked by the command via resolveAgentActor)
//   - every involved idea (endpoints and cited nodes) is live and at tier ≥ 2
//   - a non-empty one-line reason
//   - an edge would keep the graph valid (graph-rules.ts: no cycles, no
//     self edges, no duplicates; `derives` is never proposed)
//   - then fileProposals(strict): cap, citations (exact substrings; ≥ 2 for
//     edge/merge with each end cited, ≥ 1 on the idea for split/compost),
//     permanent rejections, duplicates
//
// Shapes:
//   edge    <a> <b> <rel>   rel: serves | tension | replaces
//   split   <id>            the idea reads as two claims; reason = the split
//   merge   <a> <b>         duplicates; the human picks the survivor on accept
//   compost <id>            stale or covered by other ideas
// `--mention` (edge only): the agent cites only the mentioning line (in <a>
// or <b>); roots adds the other idea's statement as the second cite
// (roots-9c29).

import { loadConfig, type RootsConfig } from "./config.ts";
import { readClaim } from "./endorse.ts";
import { GuardError, UsageError, ValidationError } from "./errors.ts";
import { readGraph } from "./graph.ts";
import { checkEdge, isLinkRel, LINK_RELS } from "./graph-rules.ts";
import type { RootsPaths } from "./paths.ts";
import { fileProposals, type ProposalDraft } from "./proposals.ts";
import { resolveNode } from "./resolve.ts";
import { requireTier } from "./tier.ts";
import type {
	Actor,
	Citation,
	EdgeRel,
	Graph,
	NodeRecord,
	ProposalKind,
	ProposalRecord,
} from "./types.ts";

export const PROPOSAL_KINDS: readonly ProposalKind[] = ["edge", "split", "merge", "compost"];
export const REASON_MAX_LENGTH = 280;

/** Positional node arguments each kind takes (edge also takes a rel). */
export const KIND_NODES: Record<ProposalKind, number> = { edge: 2, split: 1, merge: 2, compost: 1 };

export function isProposalKind(s: string): s is ProposalKind {
	return (PROPOSAL_KINDS as readonly string[]).includes(s);
}

function stripQuotes(s: string): string {
	const t = s.trim();
	return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Parse `--cite <id>:<quote>`. Splits on the FIRST colon, so the quote may
 * contain colons. The id may be any node reference (id, hex, slug, prefix).
 */
export function parseCite(raw: string, nodes: readonly NodeRecord[]): Citation {
	const colon = raw.indexOf(":");
	if (colon <= 0) {
		throw new UsageError(`--cite must be <id>:<quote>, got "${raw}"`);
	}
	const node = resolveNode(nodes, raw.slice(0, colon).trim());
	const quote = stripQuotes(raw.slice(colon + 1));
	if (quote === "") throw new UsageError(`--cite ${node.id}: the quote is empty`);
	return { node: node.id, quote };
}

export function parseLinkRel(raw: string): EdgeRel {
	const rel = raw.trim().toLowerCase();
	if (rel === "derives") {
		throw new UsageError("`derives` edges come only from `roots adopt`");
	}
	if (!isLinkRel(rel)) {
		throw new UsageError(`unknown relation "${raw}"; use ${LINK_RELS.join(", ")}`);
	}
	return rel;
}

export function cleanReason(raw: string | undefined): string {
	const reason = (raw ?? "").replace(/\s+/g, " ").trim();
	if (reason === "") throw new UsageError("--reason is required: say why, in one line");
	if (reason.length > REASON_MAX_LENGTH) {
		throw new ValidationError(
			`--reason is ${reason.length} characters; keep it under ${REASON_MAX_LENGTH}`,
		);
	}
	return reason;
}

export interface ProposeInput {
	kind: ProposalKind;
	/** Node references (1 or 2, see KIND_NODES). */
	nodes: string[];
	rel?: string;
	reason?: string;
	cites: string[];
	mention?: boolean;
	by: Actor;
	now?: Date;
}

function liveIdea(node: NodeRecord): NodeRecord {
	if (node.kind !== "idea") {
		throw new ValidationError(`${node.id} is a sprout; proposals are about human ideas`);
	}
	if (node.status === "composted") throw new ValidationError(`${node.id} is composted`);
	return node;
}

/** Validation 1: the tier allows proposals, on every idea involved. */
function checkTiers(config: RootsConfig, nodes: readonly (NodeRecord | undefined)[]): void {
	for (const node of nodes) {
		if (node?.kind === "idea") requireTier(config, 2, "`roots propose`", node);
	}
}

function citedNodes(graph: Graph, cites: readonly Citation[]): (NodeRecord | undefined)[] {
	return cites.map((c) => graph.nodes.find((n) => n.id === c.node));
}

/** --mention: the cited end holds the mentioning line; roots cites the other end's statement. */
function addMentionCite(paths: RootsPaths, graph: Graph, draft: ProposalDraft): void {
	const citesFrom = draft.cites.some((c) => c.node === draft.from);
	const citesTo = draft.cites.some((c) => c.node === draft.to);
	if (citesFrom && citesTo) return;
	if (!citesFrom && !citesTo) {
		throw new ValidationError(
			`--mention: cite the line that mentions the other idea (--cite ${draft.from}:<line>)`,
		);
	}
	const other = citesFrom ? draft.to : draft.from;
	const target = graph.nodes.find((n) => n.id === other);
	const statement = target ? readClaim(paths, graph, target).statement : "";
	if (statement !== "" && other) draft.cites.push({ node: other, quote: statement });
}

function edgeDraft(paths: RootsPaths, graph: Graph, draft: ProposalDraft, input: ProposeInput) {
	if (input.rel === undefined) throw new UsageError("propose edge needs a relation");
	draft.rel = parseLinkRel(input.rel);
	const bad = checkEdge(graph, { from: draft.from ?? "", to: draft.to ?? "", rel: draft.rel });
	if (bad) throw new ValidationError(bad);
	if (input.mention) addMentionCite(paths, graph, draft);
}

function buildDraft(
	paths: RootsPaths,
	config: RootsConfig,
	graph: Graph,
	input: ProposeInput,
): ProposalDraft {
	const want = KIND_NODES[input.kind];
	if (input.nodes.length !== want) {
		throw new UsageError(`propose ${input.kind} takes ${want} idea${want === 1 ? "" : "s"}`);
	}
	const ends = input.nodes.map((q) => resolveNode(graph.nodes, q, { kind: "idea" }));
	checkTiers(config, ends);
	const [a, b] = ends.map(liveIdea);
	if (b && a?.id === b.id) throw new ValidationError(`both ends are ${b.id}`);
	const cites = input.cites.map((c) => parseCite(c, graph.nodes));
	checkTiers(config, citedNodes(graph, cites));
	const draft: ProposalDraft = {
		kind: input.kind,
		from: a?.id,
		...(b ? { to: b.id } : {}),
		reason: cleanReason(input.reason),
		cites,
		by: input.by,
	};
	if (input.kind === "edge") edgeDraft(paths, graph, draft, input);
	else if (input.mention) throw new UsageError("--mention applies to `propose edge` only");
	return draft;
}

/** Validate and file one agent proposal. Throws on the first failed check. */
export async function proposeAsAgent(
	paths: RootsPaths,
	input: ProposeInput,
): Promise<ProposalRecord> {
	if (!input.by.startsWith("agent:")) throw new GuardError("only agents file proposals");
	const config = loadConfig(paths);
	const graph = readGraph(paths);
	const draft = buildDraft(paths, config, graph, input);
	const result = await fileProposals(paths, [draft], {
		cap: config.limits.proposals,
		ttlDays: config.limits.proposalTtlDays,
		now: input.now,
		strict: true,
	});
	const filed = result.filed[0];
	if (!filed) throw new ValidationError("proposal was not filed");
	return filed;
}
