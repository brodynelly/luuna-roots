// luuna-roots commit <id> · luuna-roots status <id> <status> · luuna-roots compost <id>
// (human, no TTY; refused inside an agent session). Transitions follow
// src/lifecycle.ts. One `status` event per change;
// `compost` logs a `compost` event with the optional reason.
//
// Seeds integration (roots-4689): committing an idea can prompt "Create seeds
// issues?" at tier ≥ 2. Implemented conservatively: when the idea's
// effective tier is ≥ 2 and the repo has .luuna/missions/, `luuna-roots commit` prints a
// hint (and `seedsHint` in --json) on how to break the idea into issues that
// link back to it. No agent runs and nothing is written to seeds: drafting
// issues "in seeds" needs a seeds-side draft concept that does not exist yet.

import { flagString } from "../args.ts";
import { loadConfig } from "../config.ts";
import { appendEvent } from "../events.ts";
import { formatStatus } from "../format.ts";
import { requireHumanCommand } from "../guard.ts";
import { parseIdeaStatus, setIdeaStatus, statusEvent } from "../lifecycle.ts";
import type { CommandContext, CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { seedsPresent } from "../seeds-link.ts";
import { effectiveTier } from "../tier.ts";
import type { IdeaStatus, NodeRecord } from "../types.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";

/** The "Create seeds issues?" nudge after a commit (see header). */
export function seedsHint(ws: Workspace, node: NodeRecord): string | null {
	if (!seedsPresent(ws.paths.root)) return null;
	if (effectiveTier(loadConfig(ws.paths), node).tier < 2) return null;
	return (
		`Create seeds issues? Link each one to this idea with ${node.id} in its description ` +
		`(e.g. sd create --title "..." --description "Realizes ${node.id}"); ` +
		`an agent can draft them from \`luuna-roots context ${node.id}\`.`
	);
}

async function change(
	ctx: CommandContext,
	command: string,
	to: IdeaStatus,
	reason?: string,
): Promise<void> {
	const { io, out, args } = ctx;
	const by = requireHumanCommand(io, command);
	const ws = await openWorkspace(io.cwd);
	const node = resolveNode(ws.graph.nodes, args[0] ?? "", { kind: "idea" });
	const done = await setIdeaStatus(ws.paths, node.id, to);
	if (done) {
		const extra = reason ? { reason } : {};
		const type = to === "composted" ? "compost" : "status";
		await appendEvent(ws.paths, statusEvent(by, node.id, done, extra, type));
	}
	const hint = done && to === "committed" ? seedsHint(ws, node) : null;
	await out.result({
		id: node.id,
		changed: done !== null,
		from: done?.from ?? to,
		to,
		...(to === "committed" ? { seedsHint: hint } : {}),
	});
	const ref = `${out.c.id(node.id)} ${node.slug}`;
	if (!done) return out.info(`${ref} is already ${formatStatus(out.c, to)}`);
	await out.success(`${ref} ${done.from} → ${formatStatus(out.c, to)}`);
	if (hint) await out.info(out.c.dim(hint));
}

export const commitCommand: CommandDef = {
	name: "commit",
	group: "structure",
	summary: "Set status to committed",
	usage: "commit <id>",
	description:
		"You stand behind this idea. Only a shaping idea (thought about at least once) commits.",
	minArgs: 1,
	maxArgs: 1,
	run: (ctx) => change(ctx, "commit", "committed"),
};

export const statusCommand: CommandDef = {
	name: "status",
	group: "structure",
	summary: "Change an idea's status",
	usage: "status <id> <status>",
	description:
		"planted → shaping → committed → built; any live idea → composted.\n" +
		"shaping is set by the first `luuna-roots think` session; composted ideas stay composted.",
	minArgs: 2,
	maxArgs: 2,
	run: (ctx) => {
		const to = parseIdeaStatus(ctx.args[1] ?? "");
		return change(ctx, "status", to);
	},
};

export const compostCommand: CommandDef = {
	name: "compost",
	group: "structure",
	summary: "Retire an idea",
	usage: "compost <id> [--reason <t>]",
	flags: {
		reason: { type: "string", placeholder: "<text>", description: "Why it is retired" },
	},
	minArgs: 1,
	maxArgs: 1,
	run: (ctx) => change(ctx, "compost", "composted", flagString(ctx.flags, "reason")),
};
