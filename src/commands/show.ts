// roots show <id>: a node with its prose, edges, questions and contributors.

import { relative } from "node:path";
import { padEnd } from "../color.ts";
import { claimStatement, type Endorsed, endorsedMarkdown, readEndorsed } from "../endorse.ts";
import { contributors, eventsFor, readEvents } from "../events.ts";
import {
	EDGE_LABEL_WIDTH,
	type EdgeDirection,
	edgeLabel,
	formatNodeRef,
	formatStatus,
} from "../format.ts";
import { findNode, incomingEdges, outgoingEdges } from "../graph.ts";
import { learningsFor, type MulchLearning } from "../mulch-link.ts";
import { listNotes, type NoteEntry } from "../notes.ts";
import type { Output } from "../output.ts";
import type { RootsPaths } from "../paths.ts";
import { pendingProposals, readProposals } from "../proposals.ts";
import { type NodeDirs, readNodeProse } from "../prose.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { type LinkedIssue, linkedIssues, readSeedsIssues } from "../seeds-link.ts";
import { sproutView } from "../sprouts.ts";
import { readTable } from "../store.ts";
import { daysLeft } from "../tend.ts";
import type { EdgeRecord, Graph, NodeRecord, ProposalRecord, QuestionRecord } from "../types.ts";
import { openWorkspace } from "../workspace.ts";

export interface NeighborView {
	edge: EdgeRecord;
	direction: EdgeDirection;
	node: (Pick<NodeRecord, "id" | "kind" | "slug" | "status"> & { statement: string }) | null;
}

function neighbor(
	paths: RootsPaths,
	graph: Graph,
	dirs: NodeDirs,
	edge: EdgeRecord,
	direction: EdgeDirection,
): NeighborView {
	const other = findNode(graph, direction === "out" ? edge.to : edge.from);
	if (!other) return { edge, direction, node: null };
	const { statement } = readNodeProse(paths, other, dirs);
	const { id, kind, slug, status } = other;
	return { edge, direction, node: { id, kind, slug, status, statement } };
}

function neighbors(paths: RootsPaths, graph: Graph, dirs: NodeDirs, node: NodeRecord) {
	return [
		...outgoingEdges(graph, node.id).map((e) => neighbor(paths, graph, dirs, e, "out")),
		...incomingEdges(graph, node.id).map((e) => neighbor(paths, graph, dirs, e, "in")),
	];
}

function edgeLine(out: Output, n: NeighborView): string {
	const { label, arrow } = edgeLabel(n.edge.rel, n.direction);
	const otherId = n.direction === "out" ? n.edge.to : n.edge.from;
	const target = n.node
		? formatNodeRef(out.c, n.node)
		: `${out.c.id(otherId)} ${out.c.red("(missing)")}`;
	const via = n.edge.proposedBy ? `, proposed by ${n.edge.proposedBy}` : "";
	return `${padEnd(label, EDGE_LABEL_WIDTH)}${arrow} ${target}${out.c.dim(`  (${n.edge.id}${via})`)}`;
}

function questionLines(out: Output, questions: QuestionRecord[]): string[] {
	const open = questions.filter((q) => q.status === "open");
	if (questions.length === 0) return [];
	const lines = [out.c.bold(`Questions (${open.length} open, ${questions.length} total)`)];
	for (const q of open) {
		const tag = q.by.startsWith("agent:") ? out.c.dim(" [agent]") : "";
		lines.push(`  ? ${out.c.id(q.id)} ${q.text}${tag}`);
	}
	return lines;
}

function proposalLines(
	out: Output,
	graph: Graph,
	node: NodeRecord,
	ps: ProposalRecord[],
): string[] {
	if (ps.length === 0) return [];
	const c = out.c;
	const lines = [c.bold(`Pending proposals (${ps.length})`) + c.dim("  (roots tend)")];
	for (const p of ps) {
		const otherId = p.from === node.id ? p.to : p.from;
		const other = otherId ? ` ${findNode(graph, otherId)?.slug ?? otherId}` : "";
		const what = p.kind === "edge" ? `${p.rel ?? "?"}${other}` : `${p.kind}${other}`;
		lines.push(`  ${c.id(p.id)} ${what}  ${c.dim(p.by)}`);
	}
	return lines;
}

function sproutMeta(out: Output, node: NodeRecord, now: Date): string[] {
	if (node.kind !== "sprout") return [];
	const c = out.c;
	const lines = [`${c.dim("author")} ${node.author} ${c.dim("[agent]")}`];
	if (node.status === "open") {
		const days = daysLeft(node.expiresAt ?? null, now);
		if (days !== null)
			lines.push(`${c.dim("expires")} in ${days}d (${node.expiresAt?.slice(0, 10)})`);
		lines.push(c.dim(`  adopt: roots adopt ${node.id} · reject: roots reject ${node.id}`));
	} else if (node.status === "expired") {
		lines.push(`${c.dim("expired")} ${node.expiresAt?.slice(0, 10) ?? ""}`);
	} else if (node.decidedBy) {
		const why = node.decisionReason ? ` ("${node.decisionReason}")` : "";
		lines.push(
			`${c.dim(node.status)} by ${node.decidedBy} ${node.decidedAt?.slice(0, 10) ?? ""}${why}`,
		);
	}
	return lines;
}

function noteLines(out: Output, notes: NoteEntry[]): string[] {
	if (notes.length === 0) return [];
	const lines = [out.c.bold(`Agent notes (${notes.length})`)];
	for (const n of notes)
		lines.push(`  ${out.c.dim("[agent]")} ${n.path}  ${out.c.dim(`${n.bytes} B`)}`);
	return lines;
}

function seedsLines(out: Output, issues: LinkedIssue[]): string[] {
	if (issues.length === 0) return [];
	const c = out.c;
	const closed = issues.filter((i) => i.closed).length;
	const lines = [c.bold(`Seeds issues (${closed}/${issues.length} closed)`)];
	for (const i of issues) {
		const mark = i.closed ? c.green("✓") : "○";
		const via = i.via === "mention" ? c.dim("  (mentions)") : "";
		lines.push(`  ${mark} ${c.id(i.id)} ${c.dim(`[${i.status}]`)} ${i.title}${via}`);
	}
	return lines;
}

function mulchLines(out: Output, learnings: MulchLearning[]): string[] {
	if (learnings.length === 0) return [];
	const c = out.c;
	const lines = [c.bold(`Mulch learnings (${learnings.length})`)];
	for (const l of learnings) {
		const id = l.id ? `${c.id(l.id)} ` : "";
		lines.push(`  ${id}${c.dim(`${l.domain}/${l.type}`)}  ${l.summary}`);
	}
	return lines;
}

interface ShowView {
	node: NodeRecord;
	notes: NoteEntry[];
	seeds: LinkedIssue[];
	mulch: MulchLearning[];
	now: Date;
	prose: ReturnType<typeof readNodeProse>;
	endorsed: Endorsed | null;
	edges: NeighborView[];
	questions: QuestionRecord[];
	proposals: ProposalRecord[];
	graph: Graph;
	contributors: string[];
	path: string | null;
}

/** The statement and body; for an endorsed idea, the endorsed claim, then the thoughts. */
function proseLines(out: Output, v: ShowView): string[] {
	const c = out.c;
	const lines: string[] = [];
	if (!v.prose.exists) lines.push(c.red("(prose file missing)"));
	if (v.endorsed) {
		// roots-9699: the endorsed text is the claim; idea.md is the human's thoughts on it.
		lines.push(`"${claimStatement(v.prose.statement, v.endorsed)}"`);
		lines.push("", ...endorsedMarkdown(v.endorsed, v.node.author).map((l) => c.dim(l)));
		if (v.prose.text.trim()) lines.push("", c.dim("thoughts"), v.prose.text.trim());
		return lines;
	}
	if (v.prose.exists) lines.push(`"${v.prose.statement}"`);
	if (v.prose.body) lines.push("", v.node.kind === "sprout" ? c.dim(v.prose.body) : v.prose.body);
	return lines;
}

function renderShow(out: Output, v: ShowView): string[] {
	const c = out.c;
	const agent = v.node.kind === "sprout" ? `${c.dim("[agent]")} ` : "";
	const lines = [
		`${agent}${c.id(c.bold(v.node.id))}  ${v.node.slug}  ${formatStatus(c, v.node.status)}`,
	];
	lines.push(...proseLines(out, v));
	const blocks = [
		sproutMeta(out, v.node, v.now),
		v.edges.map((e) => edgeLine(out, e)),
		noteLines(out, v.notes),
		seedsLines(out, v.seeds),
		mulchLines(out, v.mulch),
		questionLines(out, v.questions),
		proposalLines(out, v.graph, v.node, v.proposals),
	];
	for (const block of blocks) if (block.length > 0) lines.push("", ...block);
	lines.push("", `${c.dim("by")}    ${v.contributors.join(", ")}`);
	if (v.path) lines.push(`${c.dim("file")}  ${v.path}`);
	if (typeof v.node.tier === "number") {
		lines.push(
			`${c.dim("tier")}  ${v.node.tier} (per-idea override; \`roots tier ${v.node.id} default\` clears it)`,
		);
	}
	return lines;
}

export const showCommand: CommandDef = {
	name: "show",
	group: "read",
	summary: "Show an idea or sprout with edges, questions and history",
	usage: "show <id>",
	description:
		"<id> may be r-a1b2, a1b2, a slug, or a unique prefix of any of them.\n" +
		"For ideas, also lists linked seeds issues (.seeds/issues.jsonl: an `intent` field, else an\n" +
		"r- id in the title/description/labels) and mulch records that cite the id (read-only).",
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args }) {
		const ws = await openWorkspace(io.cwd);
		const now = new Date();
		const node = sproutView(resolveNode(ws.graph.nodes, args[0] ?? ""), now);
		const prose = readNodeProse(ws.paths, node, ws.dirs);
		const events = eventsFor(readEvents(ws.paths), node.id);
		const idea = node.kind === "idea";
		const view: ShowView = {
			node,
			now,
			notes: idea ? listNotes(ws.paths, node) : [],
			seeds: idea ? linkedIssues(readSeedsIssues(ws.paths.root), node.id) : [],
			mulch: idea ? learningsFor(ws.paths.root, node.id) : [],
			prose,
			endorsed: idea ? readEndorsed(ws.paths, ws.graph, node, ws.dirs) : null,
			edges: neighbors(ws.paths, ws.graph, ws.dirs, node),
			questions: readTable<QuestionRecord>(ws.paths.questions).filter((q) => q.node === node.id),
			proposals: pendingProposals(readProposals(ws.paths), now, ws.graph).filter(
				(p) => p.from === node.id || p.to === node.id,
			),
			graph: ws.graph,
			contributors: contributors(events, node.author),
			path: prose.path ? relative(ws.paths.root, prose.path) : null,
		};
		await out.result({
			node,
			statement: claimStatement(prose.statement, view.endorsed),
			body: view.endorsed?.statement ? view.endorsed.body : prose.body,
			endorsed: view.endorsed,
			thoughts: view.endorsed ? prose.text.trim() : null,
			path: view.path,
			missing: !prose.exists,
			edges: view.edges,
			questions: view.questions,
			proposals: view.proposals,
			contributors: view.contributors,
			notes: view.notes,
			seeds: view.seeds,
			mulch: view.mulch,
		});
		await out.lines(renderShow(out, view));
	},
};
