// Idea lifecycle. Only a human changes status.
//
//   planted → shaping → committed → built
//   (any) ─────────────────────────────→ composted
//
// `shaping` is set automatically by the first think session (see
// think-session.ts), never by hand. Humans move ideas forward one step with
// `luuna-roots commit` / `luuna-roots status <id> built`, and retire any live idea with
// `luuna-roots compost` (or a `replaces` edge). There is no way back: a composted
// idea stays composted (plant a new one instead).

import { ConflictError, UsageError } from "./errors.ts";
import { makeEvent } from "./events.ts";
import { findNode, updateGraph } from "./graph.ts";
import type { RootsPaths } from "./paths.ts";
import { isoNow } from "./time.ts";
import {
	type Actor,
	type EventRecord,
	IDEA_STATUSES,
	type IdeaStatus,
	isIdeaStatus,
	type NodeRecord,
} from "./types.ts";

/** Statuses a human may set by hand, and the statuses each may come from. */
const MANUAL_FROM: Partial<Record<IdeaStatus, readonly IdeaStatus[]>> = {
	committed: ["shaping"],
	built: ["committed"],
	composted: ["planted", "shaping", "committed", "built"],
};

export interface StatusChange {
	from: IdeaStatus;
	to: IdeaStatus;
}

export function parseIdeaStatus(raw: string): IdeaStatus {
	const s = raw.trim().toLowerCase();
	if (isIdeaStatus(s)) return s;
	throw new UsageError(`unknown status "${raw}"; statuses are ${IDEA_STATUSES.join(", ")}`);
}

/** Why `node` cannot move to `to` by hand, or null when it can. */
export function transitionError(node: NodeRecord, to: IdeaStatus): string | null {
	if (node.kind !== "idea") return `${node.id} is a sprout; sprouts are adopted or rejected`;
	const from = node.status as IdeaStatus;
	const allowed = MANUAL_FROM[to];
	if (!allowed) {
		return to === "shaping"
			? "`shaping` is set by the first `luuna-roots think` session, not by hand"
			: `\`${to}\` cannot be set by hand`;
	}
	if (allowed.includes(from)) return null;
	if (from === "composted") return `${node.id} is composted; composted ideas stay composted`;
	if (to === "committed" && from === "planted") {
		return `${node.id} is only planted; shape it with \`luuna-roots think ${node.id}\` before committing`;
	}
	return `${node.id} is ${from}; it can move to ${to} only from ${allowed.join(" or ")}`;
}

/**
 * Set an idea's status under the graph lock. Returns null when it already has
 * that status; throws ConflictError when the transition is not allowed.
 */
export async function setIdeaStatus(
	paths: RootsPaths,
	id: string,
	to: IdeaStatus,
	now = new Date(),
): Promise<StatusChange | null> {
	return updateGraph(paths, (graph) => {
		const node = findNode(graph, id);
		if (!node) throw new ConflictError(`node ${id} disappeared`);
		if (node.status === to) return { write: false, result: null };
		const err = transitionError(node, to);
		if (err) throw new ConflictError(err, { from: node.status, to });
		const from = node.status as IdeaStatus;
		node.status = to;
		node.updatedAt = isoNow(now);
		return { write: true, result: { from, to } };
	});
}

/** Compost an idea in an already-locked graph mutation (e.g. a `replaces` edge). */
export function compostInPlace(node: NodeRecord, now: Date): StatusChange | null {
	if (node.status === "composted") return null;
	const from = node.status as IdeaStatus;
	node.status = "composted";
	node.updatedAt = isoNow(now);
	return { from, to: "composted" };
}

/** One event per status change: `compost` for retirements by hand, `status` otherwise. */
export function statusEvent(
	by: Actor,
	node: string,
	change: StatusChange,
	extra: Record<string, unknown> = {},
	type: "status" | "compost" = "status",
): EventRecord {
	return makeEvent(type, by, { node, ...change, ...extra });
}
