// Human decisions on sprouts (s-), plugged into decide.ts.
//
//   accept  = adopt: needs ctx.adopt (an interactive terminal), because the
//             human rewrites the sprout as an idea in $EDITOR (adopt.ts).
//             Without a TTY the error says to run `luuna-roots adopt <id>`.
//   reject  status open → rejected, decidedBy/decidedAt/decisionReason. The
//             rejection is permanent: `luuna-roots sprout` refuses the same
//             statement forever (sprouts.ts dedup). One `reject` event.
// Overdue sprouts are expired first (lazy expiry, one `expire` event each).

import { type Decider, type Decision, registerDecider } from "./decide.ts";
import { ConflictError, GuardError, NotFoundError } from "./errors.ts";
import { appendEvent, makeEvent } from "./events.ts";
import { findNode, updateGraph } from "./graph.ts";
import { expireSprouts } from "./sprouts.ts";
import { isoNow } from "./time.ts";
import type { NodeRecord } from "./types.ts";

export function sproutDecision(
	id: string,
	action: Decision["action"],
	node: NodeRecord,
	idea: NodeRecord | null = null,
	file: string | null = null,
): Decision {
	return {
		id,
		action,
		proposals: [],
		edge: null,
		statusChanges: [],
		think: null,
		sprout: { node, idea, file },
	};
}

export const sproutDecider: Decider = {
	async accept(ctx, id) {
		if (!ctx.adopt) {
			throw new GuardError(
				`accepting ${id} means adopting it: you write the idea yourself in $EDITOR, ` +
					`so it needs an interactive terminal. Run \`luuna-roots adopt ${id}\` in a terminal ` +
					`(or \`luuna-roots reject ${id}\`)`,
			);
		}
		return ctx.adopt(id);
	},
	async reject(ctx, id, reason) {
		const now = ctx.now ?? new Date();
		await expireSprouts(ctx.paths, now);
		const why = reason?.trim() || undefined;
		const node = await updateGraph(ctx.paths, (graph) => {
			const n = findNode(graph, id);
			if (n?.kind !== "sprout") {
				throw new NotFoundError(`no sprout ${id}; \`luuna-roots list --kind sprout\` lists them`);
			}
			if (n.status !== "open") {
				const who = n.decidedBy ? ` by ${n.decidedBy}` : "";
				throw new ConflictError(`${id} is already ${n.status}${who}`, { status: n.status });
			}
			n.status = "rejected";
			n.decidedBy = ctx.by;
			n.decidedAt = isoNow(now);
			n.updatedAt = n.decidedAt;
			if (why) n.decisionReason = why;
			return { write: true, result: { ...n } };
		});
		await appendEvent(
			ctx.paths,
			makeEvent("reject", ctx.by, {
				node: id,
				sprout: id,
				kind: "sprout",
				...(why ? { reason: why } : {}),
			}),
		);
		return sproutDecision(id, "reject", node);
	},
};

registerDecider("s", sproutDecider);
