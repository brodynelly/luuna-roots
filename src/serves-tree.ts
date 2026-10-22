// The anchor → serves walk shared by `luuna-roots prime` and `luuna-roots view`
// (roots-ecaa; view.ts steps 1–3). Pure.
//
// Anchors are ideas with no outgoing `serves` to another included idea. From
// each anchor the walk follows incoming `serves` edges depth-first. Children
// are ordered by createdAt (ties: graph.jsonl order), so the preorder is a stable topological
// order: every idea appears below one idea it serves. An idea reached a second
// time (it serves more than one parent) becomes a back-reference (`ref`) with
// no children. The `seen` set also makes the walk terminate on a corrupted
// graph that has a `serves` cycle.

import { findNode } from "./graph.ts";
import type { Graph, NodeRecord } from "./types.ts";

/** Which nodes take part in the walk (e.g. live ideas). */
export type Include = (n: NodeRecord) => boolean;

export interface ServesTree {
	node: NodeRecord;
	/** Printed in full earlier; this occurrence is a back-reference. */
	ref: boolean;
	children: ServesTree[];
}

/**
 * createdAt order. Array sort is stable, so ties keep graph.jsonl order:
 * the output depends only on the data, never on the clock or on randomness.
 */
export function byCreated(a: NodeRecord, b: NodeRecord): number {
	return a.createdAt.localeCompare(b.createdAt);
}

function present(n: NodeRecord | undefined, include: Include): n is NodeRecord {
	return n !== undefined && include(n);
}

/** Included ideas that `id` serves. */
export function servesTargets(graph: Graph, id: string, include: Include): NodeRecord[] {
	return graph.edges
		.filter((e) => e.rel === "serves" && e.from === id)
		.map((e) => findNode(graph, e.to))
		.filter((n) => present(n, include));
}

/** Included ideas that serve `id`, in walk order. */
export function servedBy(graph: Graph, id: string, include: Include): NodeRecord[] {
	return graph.edges
		.filter((e) => e.rel === "serves" && e.to === id)
		.map((e) => findNode(graph, e.from))
		.filter((n) => present(n, include))
		.sort(byCreated);
}

/**
 * Included nodes with no outgoing `serves` to another included node, and for
 * which `anchor` holds (view: only committed/shaping ideas are anchors).
 */
export function anchorsOf(
	graph: Graph,
	include: Include,
	anchor: Include = () => true,
): NodeRecord[] {
	return graph.nodes
		.filter((n) => include(n) && anchor(n) && servesTargets(graph, n.id, include).length === 0)
		.sort(byCreated);
}

function walk(graph: Graph, node: NodeRecord, include: Include, seen: Set<string>): ServesTree {
	if (seen.has(node.id)) return { node, ref: true, children: [] };
	seen.add(node.id);
	const children = servedBy(graph, node.id, include).map((c) => walk(graph, c, include, seen));
	return { node, ref: false, children };
}

/** Depth-first serves forest below `roots`. Pass `seen` to share back-references. */
export function servesForest(
	graph: Graph,
	roots: readonly NodeRecord[],
	include: Include,
	seen: Set<string> = new Set(),
): ServesTree[] {
	return roots.map((r) => walk(graph, r, include, seen));
}

/** What `node` serves, transitively (breadth-first, nearest first). */
export function servesAncestors(graph: Graph, node: NodeRecord, include: Include): NodeRecord[] {
	const out: NodeRecord[] = [];
	const seen = new Set([node.id]);
	let frontier = [node];
	while (frontier.length > 0) {
		const next: NodeRecord[] = [];
		for (const n of frontier) {
			for (const t of servesTargets(graph, n.id, include)) {
				if (seen.has(t.id)) continue;
				seen.add(t.id);
				out.push(t);
				next.push(t);
			}
		}
		frontier = next;
	}
	return out;
}

/** Every tree node in preorder (back-references included). */
export function flattenForest(trees: readonly ServesTree[], into: ServesTree[] = []): ServesTree[] {
	for (const t of trees) {
		into.push(t);
		flattenForest(t.children, into);
	}
	return into;
}
