// luuna-roots log [<id>]: event history.

import { flagInt } from "../args.ts";
import { padEnd } from "../color.ts";
import { eventsFor, readEvents } from "../events.ts";
import type { Output } from "../output.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { shortTime } from "../time.ts";
import type { EventRecord, Graph } from "../types.ts";
import { openWorkspace } from "../workspace.ts";

const BASE_KEYS = new Set(["type", "by", "at", "node", "refs"]);

function describeExtra(e: EventRecord): string {
	if (e.type === "mv" && typeof e.oldSlug === "string")
		return `${e.oldSlug} → ${String(e.newSlug)}`;
	const parts = Object.entries(e)
		.filter(
			([k, v]) =>
				!BASE_KEYS.has(k) && k !== "hash" && (typeof v === "string" || typeof v === "number"),
		)
		.map(([k, v]) => `${k}=${v}`);
	return parts.join(" ");
}

function renderEvent(out: Output, graph: Graph, e: EventRecord): string {
	const slug = e.node ? graph.nodes.find((n) => n.id === e.node)?.slug : undefined;
	const subject = e.node ? `${out.c.id(e.node)}${slug ? ` ${slug}` : ""}` : "";
	const extra = describeExtra(e);
	return [
		out.c.dim(shortTime(e.at)),
		padEnd(out.c.bold(e.type), 14),
		padEnd(subject, 26),
		out.c.cyan(e.by),
		extra ? out.c.dim(extra) : "",
	]
		.join("  ")
		.trimEnd();
}

export const logCommand: CommandDef = {
	name: "log",
	group: "read",
	summary: "Event history (all, or for one node)",
	usage: "log [<id>]",
	flags: {
		limit: {
			type: "string",
			short: "n",
			placeholder: "<n>",
			description: "Only the most recent n events",
		},
	},
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		const limit = flagInt(flags, "limit");
		const ws = await openWorkspace(io.cwd);
		let events = readEvents(ws.paths);
		const node = args[0] !== undefined ? resolveNode(ws.graph.nodes, args[0]) : undefined;
		if (node) events = eventsFor(events, node.id);
		if (limit !== undefined) events = limit === 0 ? [] : events.slice(-limit);
		await out.result({ node: node?.id ?? null, count: events.length, events });
		if (events.length === 0) {
			await out.line("No events.");
			return;
		}
		await out.lines(events.map((e) => renderEvent(out, ws.graph, e)));
	},
};
