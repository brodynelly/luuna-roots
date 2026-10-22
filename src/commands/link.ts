// luuna-roots link <a> <b> <rel> (human, no TTY): add an edge directly.
// luuna-roots unlink <edge-id> (human, no TTY): remove one.
// Both refuse inside an agent session (ROOTS_AGENT set). One `link`/`unlink`
// event each; a `replaces` link also composts its target (`status` event).

import { parseLinkRel } from "../agent-proposals.ts";
import { addEdge, removeEdge } from "../edges.ts";
import { appendEvent, makeEvent } from "../events.ts";
import { edgeLabel } from "../format.ts";
import { requireHumanCommand } from "../guard.ts";
import { statusEvent } from "../lifecycle.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { openWorkspace } from "../workspace.ts";

export const linkCommand: CommandDef = {
	name: "link",
	group: "structure",
	summary: "Add an edge directly",
	usage: "link <a> <b> <rel>",
	description:
		"Relations: serves (a is a means to b), tension (a and b pull against each other),\n" +
		"replaces (a supersedes b; b is composted). serves and replaces stay acyclic;\n" +
		"tension is stored once per pair. `derives` comes only from `luuna-roots adopt`.",
	minArgs: 3,
	maxArgs: 3,
	async run({ io, out, args }) {
		const by = requireHumanCommand(io, "link");
		const [qa = "", qb = "", rawRel = ""] = args;
		const rel = parseLinkRel(rawRel);
		const ws = await openWorkspace(io.cwd);
		const a = resolveNode(ws.graph.nodes, qa, { kind: "idea" });
		const b = resolveNode(ws.graph.nodes, qb, { kind: "idea" });
		const { edge, composted } = await addEdge(ws.paths, { from: a.id, to: b.id, rel, by });
		await appendEvent(
			ws.paths,
			makeEvent("link", by, { node: a.id, refs: [b.id], edge: edge.id, rel }),
		);
		if (composted) {
			await appendEvent(ws.paths, statusEvent(by, b.id, composted, { edge: edge.id }));
		}
		await out.result({
			id: edge.id,
			edge,
			composted: composted ? { node: b.id, ...composted } : null,
		});
		const { label, arrow } = edgeLabel(rel, "out");
		await out.success(`${out.c.id(edge.id)} ${a.slug} ${arrow} ${label} ${arrow} ${b.slug}`);
		if (composted) await out.info(`  ${b.id} ${b.slug} ${composted.from} → composted`);
	},
};

export const unlinkCommand: CommandDef = {
	name: "unlink",
	group: "structure",
	summary: "Remove an edge",
	usage: "unlink <edge-id>",
	description:
		"Edge ids are listed by `luuna-roots show <id>`. Unlinking a `replaces` edge does not\n" +
		"revive the replaced idea. `derives` edges (adoption lineage) stay.",
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args }) {
		const by = requireHumanCommand(io, "unlink");
		const ws = await openWorkspace(io.cwd);
		const edge = await removeEdge(ws.paths, args[0] ?? "");
		await appendEvent(
			ws.paths,
			makeEvent("unlink", by, {
				node: edge.from,
				refs: [edge.to],
				edge: edge.id,
				rel: edge.rel,
				...(edge.proposal ? { proposal: edge.proposal } : {}),
			}),
		);
		await out.result({ id: edge.id, edge });
		await out.success(`removed ${out.c.id(edge.id)} ${edge.from} ${edge.rel} ${edge.to}`);
	},
};
