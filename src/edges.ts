// Edge mutations on graph.jsonl. Every edge is made real by a human (`link`,
// `accept`, `adopt`); `by` is always that human. Invariants live in
// graph-rules.ts. A `replaces` edge composts its target in the same locked
// write. Callers log the events (the edge event, plus a `status` event when
// the target was composted).
//
// Lock order: when a caller also holds the proposals lock, it takes the
// proposals lock first and the graph lock (here) inside it.

import { NotFoundError, UsageError, ValidationError } from "./errors.ts";
import { findNode, updateGraph } from "./graph.ts";
import { checkEdge, type EdgeCheckOptions, type EdgeDraft } from "./graph-rules.ts";
import { generateId, hexSet } from "./ids.ts";
import { compostInPlace, type StatusChange } from "./lifecycle.ts";
import type { RootsPaths } from "./paths.ts";
import { isoNow } from "./time.ts";
import type { Actor, EdgeRecord, Graph } from "./types.ts";

export interface NewEdge extends EdgeDraft {
	by: Actor;
	proposedBy?: Actor;
	proposal?: string;
}

export interface EdgeAdded {
	edge: EdgeRecord;
	/** Set when a `replaces` edge composted its target. */
	composted: StatusChange | null;
}

/**
 * Check and push one edge onto `graph` (caller holds the graph lock). A
 * `replaces` edge composts its target in place. Used by addEdge and by
 * `adopt`, which creates the idea and its `derives` edge in one locked write.
 */
export function insertEdge(
	graph: Graph,
	draft: NewEdge,
	opts: EdgeCheckOptions & { now?: Date } = {},
): EdgeAdded {
	const now = opts.now ?? new Date();
	const err = checkEdge(graph, draft, opts);
	if (err) throw new ValidationError(err, { from: draft.from, to: draft.to, rel: draft.rel });
	const edge: EdgeRecord = {
		type: "edge",
		id: generateId("e", hexSet(graph.edges.map((e) => e.id))),
		from: draft.from,
		to: draft.to,
		rel: draft.rel,
		by: draft.by,
		...(draft.proposedBy ? { proposedBy: draft.proposedBy } : {}),
		...(draft.proposal ? { proposal: draft.proposal } : {}),
		createdAt: isoNow(now),
	};
	graph.edges.push(edge);
	const target = draft.rel === "replaces" ? findNode(graph, draft.to) : undefined;
	const composted = target ? compostInPlace(target, now) : null;
	return { edge, composted };
}

export async function addEdge(
	paths: RootsPaths,
	draft: NewEdge,
	opts: EdgeCheckOptions & { now?: Date } = {},
): Promise<EdgeAdded> {
	return updateGraph(paths, (graph) => ({ write: true, result: insertEdge(graph, draft, opts) }));
}

/** Remove one edge. `derives` is lineage and is never removed. */
export async function removeEdge(paths: RootsPaths, edgeId: string): Promise<EdgeRecord> {
	const id = edgeId.trim().toLowerCase();
	return updateGraph(paths, (graph) => {
		const idx = graph.edges.findIndex((e) => e.id === id || e.id === `e-${id}`);
		const edge = graph.edges[idx];
		if (!edge) throw new NotFoundError(`no edge ${edgeId}; \`luuna-roots show <id>\` lists edge ids`);
		if (edge.rel === "derives") {
			throw new UsageError(`${edge.id} is a \`derives\` edge (adoption lineage); it stays`);
		}
		graph.edges.splice(idx, 1);
		return { write: true, result: edge };
	});
}
