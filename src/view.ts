// `luuna-roots view`: the compiled culmination (roots-ecaa).
//
//   1. Anchors: `committed`/`shaping` ideas with no outgoing `serves`
//      (to another live idea).
//   2. Each anchor: statement + prose, then the ideas that serve it,
//      depth-first in topological order (serves-tree.ts, shared with prime).
//   3. An idea that serves more than one parent is printed once; later
//      occurrences are back-references.
//   4. Tensions (both ends live) and open questions.
//   5. Composted ideas and sprouts are excluded; `sprouts: true` adds a
//      separate "Agent proposals (not accepted)" section, every entry [agent].
//
// Ideas the walk never reaches (planted ideas, and ideas that only serve
// planted or built ones) are not dropped silently: they are listed, one line
// each, under "Not yet under an anchor". Anchors are only
// committed/shaping ideas, so a planted idea is not a goal yet, but hiding it
// would make the document lie about what the graph holds.
//
// Output is deterministic: order comes from the data only (createdAt, then
// graph.jsonl order), and the Markdown has no timestamps, so ROOTS.md diffs
// show only changes in intent.

import { answerBlocks, buildBlame } from "./blame.ts";
import type { RootsConfig } from "./config.ts";
import { claimStatement, type Endorsed, endorsedMarkdown, readEndorsed } from "./endorse.ts";
import { findNode } from "./graph.ts";
import { readNodeProse } from "./prose.ts";
import { byCreated, flattenForest, type ServesTree, servesForest } from "./serves-tree.ts";
import { openSprouts } from "./sprouts.ts";
import type { Actor, EventRecord, Graph, NodeRecord, QuestionRecord } from "./types.ts";
import type { Workspace } from "./workspace.ts";

export interface ViewIdea {
	id: string;
	slug: string;
	status: NodeRecord["status"];
	/** The claim: for an endorsed idea, the endorsed agent statement (roots-9699). */
	statement: string;
	body: string;
	/** The body split by the question each part answered (luuna-roots blame). */
	blocks: ViewBlock[];
	/** Endorsed ideas: the agent text the human accepted (quoted, labeled). */
	endorsed?: Endorsed | null;
	author?: Actor;
}

export interface ViewBlock {
	question: ViewQuestion | null;
	text: string;
}

export interface ViewNode extends ViewIdea {
	/** Printed in full earlier; this occurrence is a back-reference (body is ""). */
	ref: boolean;
	children: ViewNode[];
}

export interface ViewTension {
	edge: string;
	a: string;
	b: string;
}

export interface ViewQuestion {
	id: string;
	node: string;
	text: string;
	by: string;
	/** Asked by an agent (rendered [agent]); otherwise by a deterministic rule. */
	agent: boolean;
}

export interface ViewSprout {
	id: string;
	slug: string;
	statement: string;
	body: string;
	by: string;
	expiresAt: string | null;
}

export interface ViewEdge {
	from: string;
	to: string;
	rel: "serves" | "tension";
}

export interface ViewData {
	project: string;
	from: string | null;
	tree: ViewNode[];
	/** Live ideas the walk did not reach (only without --from). */
	unanchored: ViewIdea[];
	tensions: ViewTension[];
	questions: ViewQuestion[];
	/** Open sprouts (only with --sprouts), else null. */
	sprouts: ViewSprout[] | null;
	/** Every idea in the document, by id (statement lookups for tensions/refs). */
	ideas: Record<string, ViewIdea>;
	/** serves/tension edges between ideas in the document (for the HTML graph). */
	edges: ViewEdge[];
}

export interface ViewOptions {
	from?: NodeRecord | null;
	sprouts?: boolean;
	now?: Date;
	/** events.jsonl rows; with them, bodies are split by the question they answered. */
	events?: readonly EventRecord[];
}

type WsView = Pick<Workspace, "paths" | "graph" | "dirs">;

interface Src {
	ws: WsView;
	events: readonly EventRecord[];
	questions: readonly QuestionRecord[];
}

function viewQuestion(q: QuestionRecord): ViewQuestion {
	return { id: q.id, node: q.node, text: q.text, by: q.by, agent: q.by.startsWith("agent:") };
}

const ANCHOR_STATUSES = new Set(["committed", "shaping"]);

export function isLiveIdea(n: NodeRecord | undefined): n is NodeRecord {
	return n !== undefined && n.kind === "idea" && n.status !== "composted";
}

/** View anchors: live ideas that serve nothing live, and are committed or shaping. */
export function viewAnchors(graph: Graph): NodeRecord[] {
	return graph.nodes
		.filter(
			(n) =>
				isLiveIdea(n) &&
				ANCHOR_STATUSES.has(n.status) &&
				!graph.edges.some(
					(e) => e.rel === "serves" && e.from === n.id && isLiveIdea(findNode(graph, e.to)),
				),
		)
		.sort(byCreated);
}

function readIdea(src: Src, n: NodeRecord): ViewIdea {
	const prose = readNodeProse(src.ws.paths, n, src.ws.dirs);
	const blame = buildBlame(n.id, prose.text, src.events, src.questions);
	const blocks = answerBlocks(blame).map((b) => {
		const q = b.question ? src.questions.find((r) => r.id === b.question) : undefined;
		return { question: q ? viewQuestion(q) : null, text: b.text };
	});
	const { statement, body } = prose;
	const endorsed = readEndorsed(src.ws.paths, src.ws.graph, n, src.ws.dirs);
	const idea: ViewIdea = { id: n.id, slug: n.slug, status: n.status, statement, body, blocks };
	if (!endorsed) return idea;
	// roots-9699: the endorsed text is the claim; all of idea.md is the human's thoughts.
	const thoughts = statement ? [{ question: null, text: statement }, ...blocks] : blocks;
	return {
		...idea,
		statement: claimStatement(statement, endorsed),
		blocks: thoughts,
		endorsed,
		author: n.author,
	};
}

function toViewNode(ideas: Record<string, ViewIdea>, t: ServesTree): ViewNode {
	const idea = ideas[t.node.id] ?? {
		id: t.node.id,
		slug: t.node.slug,
		status: t.node.status,
		statement: "",
		body: "",
		blocks: [],
	};
	return {
		...idea,
		body: t.ref ? "" : idea.body,
		blocks: t.ref ? [] : idea.blocks,
		ref: t.ref,
		children: t.children.map((c) => toViewNode(ideas, c)),
	};
}

function tensionsWithin(graph: Graph, ids: ReadonlySet<string>): ViewTension[] {
	return graph.edges
		.filter((e) => e.rel === "tension")
		.filter((e) => isLiveIdea(findNode(graph, e.from)) && isLiveIdea(findNode(graph, e.to)))
		.filter((e) => ids.has(e.from) || ids.has(e.to))
		.sort((x, y) => x.createdAt.localeCompare(y.createdAt))
		.map((e) => ({ edge: e.id, a: e.from, b: e.to }));
}

function openQuestions(rows: readonly QuestionRecord[], order: readonly string[]): ViewQuestion[] {
	const rank = new Map(order.map((id, i) => [id, i]));
	return rows
		.filter((q) => q.status === "open" && rank.has(q.node))
		.sort(
			(a, b) =>
				(rank.get(a.node) ?? 0) - (rank.get(b.node) ?? 0) ||
				a.createdAt.localeCompare(b.createdAt) ||
				a.id.localeCompare(b.id),
		)
		.map(viewQuestion);
}

function sproutsFor(ws: WsView, now: Date): ViewSprout[] {
	return openSprouts(ws.graph, now)
		.sort(byCreated)
		.map((s) => {
			const prose = readNodeProse(ws.paths, s, ws.dirs);
			return {
				id: s.id,
				slug: s.slug,
				statement: prose.statement,
				body: prose.body,
				by: s.author,
				expiresAt: s.expiresAt ?? null,
			};
		});
}

function viewEdges(graph: Graph, ids: ReadonlySet<string>): ViewEdge[] {
	const out: ViewEdge[] = [];
	for (const e of graph.edges) {
		if ((e.rel === "serves" || e.rel === "tension") && ids.has(e.from) && ids.has(e.to)) {
			out.push({ from: e.from, to: e.to, rel: e.rel });
		}
	}
	return out;
}

export function buildView(
	ws: WsView,
	config: Pick<RootsConfig, "project">,
	questions: readonly QuestionRecord[],
	opts: ViewOptions = {},
): ViewData {
	const src: Src = { ws, events: opts.events ?? [], questions };
	const from = opts.from ?? null;
	const roots = from ? [from] : viewAnchors(ws.graph);
	const forest = servesForest(ws.graph, roots, isLiveIdea);
	const printed = flattenForest(forest).filter((t) => !t.ref);
	const reached = new Set(printed.map((t) => t.node.id));
	const rest = from
		? []
		: ws.graph.nodes.filter((n) => isLiveIdea(n) && !reached.has(n.id)).sort(byCreated);
	const ideas: Record<string, ViewIdea> = {};
	for (const n of [...printed.map((t) => t.node), ...rest]) ideas[n.id] = readIdea(src, n);
	const inDoc = new Set(Object.keys(ideas));
	const tensions = tensionsWithin(ws.graph, inDoc);
	for (const t of tensions) {
		for (const id of [t.a, t.b]) {
			const n = findNode(ws.graph, id);
			if (n && !ideas[id]) ideas[id] = readIdea(src, n);
		}
	}
	return {
		project: config.project,
		from: from?.id ?? null,
		tree: forest.map((t) => toViewNode(ideas, t)),
		unanchored: rest.map((n) => ideas[n.id] ?? readIdea(src, n)),
		tensions,
		questions: openQuestions(questions, [...inDoc]),
		sprouts: opts.sprouts ? sproutsFor(ws, opts.now ?? new Date()) : null,
		ideas,
		edges: viewEdges(ws.graph, inDoc),
	};
}

// ── Markdown ──────────────────────────────────────────────────────────────

export const VIEW_HEADER =
	"<!-- Generated by `luuna-roots view` from .luuna/roots/. Do not edit by hand: ideas change in " +
	"`luuna-roots think`, structure in `luuna-roots tend` / `luuna-roots link`. -->";

function statementOf(s: string): string {
	return s === "" ? "(empty)" : s;
}

/** `Q:` line for an answered block: the question is not human prose, so it is quoted. */
export function questionLabel(q: ViewQuestion): string {
	const who = q.agent ? `[agent] ${q.by.slice("agent:".length)}` : q.by;
	return `**Q:** ${q.text} _(\`${q.id}\` · ${who})_`;
}

function blockLines(n: ViewIdea): string[] {
	const lines: string[] = [];
	for (const b of n.blocks) {
		if (b.question) lines.push(`> ${questionLabel(b.question)}`, "");
		lines.push(b.text, "");
	}
	return lines;
}

function nodeLines(n: ViewNode, depth: number): string[] {
	if (n.ref) {
		return [`↑ Also serves this: **${statementOf(n.statement)}** (\`${n.id}\`), shown above.`, ""];
	}
	const hashes = "#".repeat(Math.min(2 + depth, 6));
	const lines = [
		`${hashes} ${statementOf(n.statement)}`,
		"",
		`\`${n.id}\` · ${n.slug} · ${n.status}`,
	];
	lines.push("");
	if (n.endorsed) lines.push(...endorsedMarkdown(n.endorsed, n.author), "");
	lines.push(...blockLines(n));
	for (const c of n.children) lines.push(...nodeLines(c, depth + 1));
	return lines;
}

function ideaRef(d: ViewData, id: string): string {
	const idea = d.ideas[id];
	return `**${statementOf(idea?.statement ?? "")}** (\`${id}\`)`;
}

function unanchoredLines(d: ViewData): string[] {
	if (d.unanchored.length === 0) return [];
	return [
		"## Not yet under an anchor",
		"",
		"Live ideas outside the tree above: planted ideas, and ideas that serve only unshaped ones.",
		"",
		...d.unanchored.map((i) => `- ${statementOf(i.statement)} (\`${i.id}\` · ${i.status})`),
		"",
	];
}

function tensionLines(d: ViewData): string[] {
	if (d.tensions.length === 0) return [];
	return [
		"## Tensions",
		"",
		...d.tensions.map((t) => `- ${ideaRef(d, t.a)} ↔ ${ideaRef(d, t.b)}`),
		"",
	];
}

function questionLines(d: ViewData): string[] {
	if (d.questions.length === 0) return [];
	return [
		"## Open questions",
		"",
		...d.questions.map((q) => {
			const who = q.agent ? `[agent] ${q.by}` : q.by;
			const slug = d.ideas[q.node]?.slug ?? "";
			return `- \`${q.node}\` ${slug}: ${q.text} _(${who})_`;
		}),
		"",
	];
}

function quote(text: string): string[] {
	return text.split("\n").map((l) => (l === "" ? ">" : `> ${l}`));
}

function sproutLines(d: ViewData): string[] {
	if (d.sprouts === null) return [];
	const lines = [
		"## Agent proposals (not accepted)",
		"",
		"_Written by agents. Not part of this project's intent unless a human adopts one in their own words._",
		"",
	];
	if (d.sprouts.length === 0) lines.push("(no open sprouts)", "");
	for (const s of d.sprouts) {
		lines.push(`### [agent] ${statementOf(s.statement)}`, "");
		lines.push(`\`${s.id}\` · ${s.slug} · proposed by ${s.by}`, "");
		if (s.body !== "") lines.push(...quote(s.body), "");
	}
	return lines;
}

export function renderViewMarkdown(d: ViewData): string {
	const title = d.from ? `# ${d.project}: intent from \`${d.from}\`` : `# ${d.project}: intent`;
	const lines = [VIEW_HEADER, "", title, ""];
	if (d.tree.length === 0) lines.push("(no committed or shaping ideas yet)", "");
	for (const n of d.tree) lines.push(...nodeLines(n, 0));
	lines.push(...unanchoredLines(d), ...tensionLines(d), ...questionLines(d), ...sproutLines(d));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return `${lines.join("\n")}\n`;
}
