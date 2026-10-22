// luuna-roots scan [<id>]: find mentions in edits made outside a think session.
//
// Roots never caches prose, so there is no "before" text to diff against.
// Instead each idea's current content hash is compared with its last
// recorded hash (the latest `plant` or `session.end` hash, or a previous
// `scan`'s scannedHash). When they differ, every line of idea.md is scanned
// for mentions; dedup and permanent rejections keep re-scans from refiling.
// A `scan` event records `scannedHash` so the next scan skips unchanged
// ideas. It is deliberately NOT named `hash`: verify's hash ledger trusts
// only plant/session.end hashes, so a scan never launders an edit.

import { resolveHumanActor } from "../actor.ts";
import { flagBool } from "../args.ts";
import { loadConfig } from "../config.ts";
import { allLines } from "../diff.ts";
import { appendEvent, makeEvent, readEvents } from "../events.ts";
import { type MentionFiling, proposeMentions } from "../mention-scan.ts";
import type { Output } from "../output.ts";
import { contentHash, readNodeProse } from "../prose.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import type { Actor, EventRecord, NodeRecord } from "../types.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";

/** The latest recorded content hash for a node, or null. */
export function lastRecordedHash(events: readonly EventRecord[], id: string): string | null {
	let last: string | null = null;
	for (const e of events) {
		if (e.node !== id) continue;
		const h =
			e.type === "plant" || e.type === "session.end"
				? e.hash
				: e.type === "scan"
					? e.scannedHash
					: null;
		if (typeof h === "string") last = h;
	}
	return last;
}

interface ScanItem {
	node: NodeRecord;
	changed: boolean;
	filing: MentionFiling | null;
}

function targets(ws: Workspace, query: string | undefined): NodeRecord[] {
	if (query !== undefined) return [resolveNode(ws.graph.nodes, query, { kind: "idea" })];
	return ws.graph.nodes.filter((n) => n.kind === "idea" && n.status !== "composted");
}

async function scanOne(
	ws: Workspace,
	node: NodeRecord,
	ctx: { events: EventRecord[]; all: boolean; by: Actor; now: Date },
): Promise<ScanItem> {
	const prose = readNodeProse(ws.paths, node, ws.dirs);
	if (!prose.exists) return { node, changed: false, filing: null };
	const hash = contentHash(prose.text);
	const changed = hash !== lastRecordedHash(ctx.events, node.id);
	if (!changed && !ctx.all) return { node, changed, filing: null };
	const config = loadConfig(ws.paths);
	const filing = await proposeMentions(
		ws.paths,
		config,
		ws.graph,
		node.id,
		allLines(prose.text),
		ctx.now,
	);
	const filed = filing.result.filed.map((p) => p.id);
	if (changed || filed.length > 0) {
		await appendEvent(
			ws.paths,
			makeEvent("scan", ctx.by, { node: node.id, scannedHash: hash, proposals: filed }),
		);
	}
	return { node, changed, filing };
}

function itemJson(i: ScanItem) {
	return {
		node: i.node.id,
		slug: i.node.slug,
		changed: i.changed,
		scanned: i.filing !== null,
		mentions: i.filing?.mentions ?? [],
		filed: i.filing?.result.filed ?? [],
		skipped: (i.filing?.result.skipped ?? []).map((s) => ({ to: s.draft.to, reason: s.reason })),
	};
}

async function printScan(out: Output, items: ScanItem[]): Promise<void> {
	const c = out.c;
	const scanned = items.filter((i) => i.filing !== null);
	const filed = scanned.flatMap((i) => i.filing?.result.filed ?? []);
	for (const i of scanned) {
		for (const p of i.filing?.result.filed ?? []) {
			await out.line(
				`${c.green("+")} ${c.id(p.id)} ${i.node.slug} ─?─ ${p.to}  ${c.dim(p.reason ?? "")}`,
			);
		}
	}
	const summary = `scanned ${scanned.length} changed idea${scanned.length === 1 ? "" : "s"}; ${filed.length} proposal${filed.length === 1 ? "" : "s"} filed`;
	await out.success(summary);
	if (filed.length > 0) await out.info(c.dim("review them with `luuna-roots tend`"));
}

export const scanCommand: CommandDef = {
	name: "scan",
	group: "structure",
	summary: "Find mentions in edits made outside a session",
	usage: "scan [<id>]",
	description:
		"Scans ideas whose idea.md changed since its last recorded hash (plant, think\n" +
		"session end, or a previous scan) and files link proposals for mentions of other\n" +
		"ideas (slug, id, or a distinctive phrase from their statement).",
	flags: {
		all: { type: "boolean", description: "Scan every idea, changed or not" },
	},
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		const by = resolveHumanActor(io);
		const ws = await openWorkspace(io.cwd);
		const ctx = { events: readEvents(ws.paths), all: flagBool(flags, "all"), by, now: new Date() };
		const items: ScanItem[] = [];
		for (const node of targets(ws, args[0])) items.push(await scanOne(ws, node, ctx));
		await out.result({ ideas: items.map(itemJson) });
		await printScan(out, items);
	},
};
