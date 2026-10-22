// Graph invariants (roots-4143). Pure. Used when an edge is created
// (`link`, `accept`, `adopt`), when an agent proposes one (so it cannot file
// an edge a human could never accept), and by `luuna-roots verify` over the whole
// graph.
//
//   no self edges; both endpoints exist
//   serves, replaces   acyclic (per rel)
//   tension            symmetric, stored once: A↔B == B↔A
//   derives            idea (r-) → sprout (s-) only, and only via `adopt`
//   serves/tension/replaces connect ideas only; never from a composted idea,
//   and never to a composted idea except as the target of `replaces`
// A pair holds at most one edge per rel (tension: per unordered pair).

import { findNode } from "./graph.ts";
import type { EdgeRecord, EdgeRel, Graph, NodeRecord } from "./types.ts";

export const DIRECTED_RELS: readonly EdgeRel[] = ["serves", "replaces", "derives"];
export const ACYCLIC_RELS: readonly EdgeRel[] = ["serves", "replaces"];
/** Relations a human may create directly (`link`) or an agent may propose. */
export const LINK_RELS = ["serves", "tension", "replaces"] as const;
export type LinkRel = (typeof LINK_RELS)[number];

export function isLinkRel(s: string): s is LinkRel {
	return (LINK_RELS as readonly string[]).includes(s);
}

export interface EdgeDraft {
	from: string;
	to: string;
	rel: EdgeRel;
}

export interface EdgeCheckOptions {
	/** Only `adopt` may create `derives`. */
	allowDerives?: boolean;
	/** Edge ids to ignore (verify checks each edge against the others). */
	ignore?: ReadonlySet<string>;
}

/** Same pair for this rel: ordered for directed rels, unordered for tension. */
export function sameEdgeKey(a: EdgeDraft, b: EdgeDraft): boolean {
	if (a.rel !== b.rel) return false;
	if (a.from === b.from && a.to === b.to) return true;
	return a.rel === "tension" && a.from === b.to && a.to === b.from;
}

/** True when `to` already reaches `from` over `rel` edges (adding from→to closes a cycle). */
export function wouldCycle(
	edges: readonly EdgeRecord[],
	draft: EdgeDraft,
	ignore?: ReadonlySet<string>,
): boolean {
	const seen = new Set<string>();
	const stack = [draft.to];
	while (stack.length > 0) {
		const id = stack.pop() ?? "";
		if (id === draft.from) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const e of edges) {
			if (e.rel === draft.rel && e.from === id && !ignore?.has(e.id)) stack.push(e.to);
		}
	}
	return false;
}

function label(n: NodeRecord): string {
	return `${n.id} ${n.slug}`;
}

function checkDerives(from: NodeRecord, to: NodeRecord, opts: EdgeCheckOptions): string | null {
	if (!opts.allowDerives) return "`derives` edges are created only by `luuna-roots adopt`";
	if (from.kind !== "idea" || to.kind !== "sprout") {
		return "`derives` goes from an idea (r-) to a sprout (s-)";
	}
	return null;
}

function checkEndpoints(from: NodeRecord, to: NodeRecord, rel: EdgeRel): string | null {
	for (const n of [from, to]) {
		if (n.kind !== "idea") return `${label(n)} is a sprout; \`${rel}\` connects ideas only`;
	}
	if (from.status === "composted") return `${label(from)} is composted`;
	if (to.status === "composted" && rel !== "replaces") return `${label(to)} is composted`;
	return null;
}

function checkShape(graph: Graph, d: EdgeDraft, opts: EdgeCheckOptions): string | null {
	if (d.from === d.to) return `an idea cannot ${d.rel} itself (${d.from})`;
	const from = findNode(graph, d.from);
	const to = findNode(graph, d.to);
	if (!from) return `node ${d.from} does not exist`;
	if (!to) return `node ${d.to} does not exist`;
	if (d.rel === "derives") return checkDerives(from, to, opts);
	return checkEndpoints(from, to, d.rel);
}

/** Error message for the first broken invariant, or null when `d` may be added. */
export function checkEdge(graph: Graph, d: EdgeDraft, opts: EdgeCheckOptions = {}): string | null {
	const shape = checkShape(graph, d, opts);
	if (shape) return shape;
	const edges = graph.edges.filter((e) => !opts.ignore?.has(e.id));
	const dup = edges.find((e) => sameEdgeKey(e, d));
	if (dup) return `${d.from} ${d.rel} ${d.to} already exists (${dup.id})`;
	if (ACYCLIC_RELS.includes(d.rel) && wouldCycle(edges, d)) {
		return `${d.from} ${d.rel} ${d.to} would create a \`${d.rel}\` cycle (${d.rel} must stay acyclic)`;
	}
	return null;
}

export interface GraphViolation {
	edge: string;
	message: string;
}

/**
 * Every edge that breaks an invariant, checked against the rest of the graph
 * (for `luuna-roots verify`). A `replaces` target that is not composted is also a
 * violation. Endpoint status is not re-checked here: ideas may be composted
 * after their edges were made.
 */
export function graphViolations(graph: Graph): GraphViolation[] {
	const out: GraphViolation[] = [];
	for (const e of graph.edges) {
		const ignore = new Set([e.id]);
		const shape =
			e.from === e.to
				? `self edge on ${e.from}`
				: !findNode(graph, e.from) || !findNode(graph, e.to)
					? `endpoint missing (${e.from} → ${e.to})`
					: null;
		const msg =
			shape ??
			checkEdgeStructure(graph, e, ignore) ??
			(e.rel === "replaces" && findNode(graph, e.to)?.status !== "composted"
				? `${e.to} is replaced by ${e.from} but is not composted`
				: null);
		if (msg) out.push({ edge: e.id, message: msg });
	}
	return out;
}

function checkEdgeStructure(graph: Graph, e: EdgeRecord, ignore: Set<string>): string | null {
	const from = findNode(graph, e.from);
	const to = findNode(graph, e.to);
	if (!from || !to) return null;
	if (e.rel === "derives") return checkDerives(from, to, { allowDerives: true });
	if (from.kind !== "idea" || to.kind !== "idea") return `\`${e.rel}\` on a sprout`;
	const others = graph.edges.filter((x) => !ignore.has(x.id));
	const dup = others.find((x) => sameEdgeKey(x, e));
	if (dup) return `duplicate of ${dup.id}`;
	if (ACYCLIC_RELS.includes(e.rel) && wouldCycle(others, e)) return `\`${e.rel}\` cycle`;
	return null;
}
