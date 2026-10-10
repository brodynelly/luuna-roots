// roots list: ideas and sprouts, filtered.

import { flagBool, flagString } from "../args.ts";
import { padEnd, visibleLength } from "../color.ts";
import { readClaim } from "../endorse.ts";
import { UsageError } from "../errors.ts";
import { formatNodeRef, formatStatus, truncate } from "../format.ts";
import { isAnchor, isOrphan } from "../graph.ts";
import type { Output } from "../output.ts";
import type { CommandDef } from "../registry.ts";
import { sproutView } from "../sprouts.ts";
import { daysLeft } from "../tend.ts";
import {
	type Graph,
	IDEA_STATUSES,
	isIdeaStatus,
	isNodeKind,
	isSproutStatus,
	type NodeKind,
	type NodeRecord,
	SPROUT_STATUSES,
} from "../types.ts";
import { openWorkspace } from "../workspace.ts";

export interface ListFilter {
	status?: string;
	kind?: NodeKind;
	orphans: boolean;
	anchors: boolean;
	all: boolean;
}

/** Hidden unless --all or an explicit --status: retired ideas and closed sprouts. */
function isRetired(node: NodeRecord): boolean {
	return node.kind === "idea" ? node.status === "composted" : node.status !== "open";
}

export function filterNodes(graph: Graph, f: ListFilter): NodeRecord[] {
	return graph.nodes
		.filter((n) => (f.status ? n.status === f.status : f.all || !isRetired(n)))
		.filter((n) => !f.kind || n.kind === f.kind)
		.filter((n) => !f.orphans || isOrphan(graph, n))
		.filter((n) => !f.anchors || isAnchor(graph, n))
		.sort((a, b) =>
			a.kind === b.kind ? a.createdAt.localeCompare(b.createdAt) : a.kind === "idea" ? -1 : 1,
		);
}

function parseFilter(flags: Parameters<CommandDef["run"]>[0]["flags"]): ListFilter {
	const status = flagString(flags, "status");
	if (status !== undefined && !isIdeaStatus(status) && !isSproutStatus(status)) {
		const valid = [...IDEA_STATUSES, ...SPROUT_STATUSES].join("|");
		throw new UsageError(`invalid --status "${status}" (valid: ${valid})`);
	}
	const kind = flagString(flags, "kind");
	if (kind !== undefined && !isNodeKind(kind)) {
		throw new UsageError(`invalid --kind "${kind}" (valid: idea|sprout)`);
	}
	return {
		status,
		kind,
		orphans: flagBool(flags, "orphans"),
		anchors: flagBool(flags, "anchors"),
		all: flagBool(flags, "all"),
	};
}

interface Row {
	node: NodeRecord;
	statement: string;
}

function expiry(out: Output, node: NodeRecord, now: Date): string {
	if (node.kind !== "sprout" || node.status !== "open") return "";
	const days = daysLeft(node.expiresAt ?? null, now);
	return days === null ? "" : out.c.dim(`  (expires in ${days}d)`);
}

function renderRows(out: Output, rows: Row[], now: Date): string[] {
	const refs = rows.map((r) => formatNodeRef(out.c, r.node));
	const refWidth = Math.max(...refs.map(visibleLength)) + 2;
	return rows.map((r, i) => {
		const status = padEnd(formatStatus(out.c, r.node.status), 11);
		const text = truncate(r.statement || "(no statement)", 72);
		const stmt = r.node.kind === "sprout" ? out.c.dim(text) : text;
		return `${padEnd(refs[i] ?? "", refWidth)}${status}${stmt}${expiry(out, r.node, now)}`;
	});
}

export const listCommand: CommandDef = {
	name: "list",
	group: "read",
	summary: "List ideas and sprouts",
	usage: "list [--status <s>] [--kind idea|sprout] [--orphans] [--anchors]",
	description:
		"By default composted ideas and closed sprouts are hidden; use --all or --status.\n" +
		"--orphans: no edges at all. --anchors: live ideas with no outgoing `serves`.",
	flags: {
		status: { type: "string", placeholder: "<status>", description: "Only nodes with this status" },
		kind: { type: "string", placeholder: "<kind>", description: "idea or sprout" },
		orphans: { type: "boolean", description: "Only nodes with no edges" },
		anchors: { type: "boolean", description: "Only anchors (ideas with no outgoing serves)" },
		all: { type: "boolean", short: "a", description: "Include composted ideas and closed sprouts" },
	},
	maxArgs: 0,
	async run({ io, out, flags }) {
		const filter = parseFilter(flags);
		const ws = await openWorkspace(io.cwd);
		const now = new Date();
		const graph = { ...ws.graph, nodes: ws.graph.nodes.map((n) => sproutView(n, now)) };
		const rows: Row[] = filterNodes(graph, filter).map((node) => ({
			node,
			statement: readClaim(ws.paths, ws.graph, node, ws.dirs).statement,
		}));
		await out.result({
			count: rows.length,
			nodes: rows.map((r) => ({ ...r.node, statement: r.statement })),
		});
		if (rows.length === 0) {
			const empty = ws.graph.nodes.length === 0;
			await out.line(
				empty ? 'No ideas yet. Plant one: roots plant "<one sentence>"' : "No matches.",
			);
			return;
		}
		await out.lines(renderRows(out, rows, now));
	},
};
