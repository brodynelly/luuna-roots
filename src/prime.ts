// `roots prime`: the accepted graph as agent context.
// Anchors (top-level goals) with the ideas that serve them nested below,
// tensions, per-idea tier overrides, and a short guide to using roots as an
// agent. Read-only; only human prose and human-made edges appear. Sprouts,
// proposals and composted ideas are left out.

import type { RootsConfig } from "./config.ts";
import { readEndorsed } from "./endorse.ts";
import { findNode } from "./graph.ts";
import { readNodeProse } from "./prose.ts";
import { anchorsOf, type ServesTree, servesAncestors, servesForest } from "./serves-tree.ts";
import { type EffectiveTier, effectiveTier } from "./tier.ts";
import type { Graph, NodeRecord } from "./types.ts";
import type { Workspace } from "./workspace.ts";

export interface PrimeNode {
	id: string;
	slug: string;
	status: NodeRecord["status"];
	statement: string;
	tier?: number;
	/** Endorsed ideas: the agent text the human accepted (roots-6205). */
	endorses?: { sprout: string; by: string; statement: string; changed: boolean };
	/** Printed in full earlier; this occurrence is a back-reference. */
	ref?: boolean;
	children: PrimeNode[];
}

export interface PrimeTension {
	edge: string;
	a: string;
	b: string;
}

export interface PrimeData {
	project: string;
	tier: EffectiveTier;
	questionsPerSession: number;
	scope: string | null;
	ideas: number;
	committed: number;
	/** Scoped: what the scope idea serves (upward, nearest first). */
	serves: { id: string; slug: string }[];
	tree: PrimeNode[];
	tensions: PrimeTension[];
	overrides: { id: string; slug: string; tier: number }[];
}

type WsView = Pick<Workspace, "paths" | "graph" | "dirs">;

function isLive(n: NodeRecord | undefined): n is NodeRecord {
	return n !== undefined && n.kind === "idea" && n.status !== "composted";
}

/** Live ideas with no outgoing `serves` to another live idea. */
export function primeAnchors(graph: Graph): NodeRecord[] {
	return anchorsOf(graph, isLive);
}

function toPrimeNode(ws: WsView, t: ServesTree): PrimeNode {
	const n = t.node;
	const e = readEndorsed(ws.paths, ws.graph, n, ws.dirs);
	return {
		id: n.id,
		slug: n.slug,
		status: n.status,
		statement: readNodeProse(ws.paths, n, ws.dirs).statement,
		...(typeof n.tier === "number" ? { tier: n.tier } : {}),
		...(e
			? { endorses: { sprout: e.sprout, by: e.by, statement: e.statement, changed: e.changed } }
			: {}),
		...(t.ref ? { ref: true } : {}),
		children: t.children.map((c) => toPrimeNode(ws, c)),
	};
}

function upward(graph: Graph, node: NodeRecord): { id: string; slug: string }[] {
	return servesAncestors(graph, node, isLive).map((n) => ({ id: n.id, slug: n.slug }));
}

function tensions(graph: Graph, within: Set<string> | null): PrimeTension[] {
	return graph.edges
		.filter((e) => e.rel === "tension")
		.filter((e) => isLive(findNode(graph, e.from)) && isLive(findNode(graph, e.to)))
		.filter((e) => within === null || within.has(e.from) || within.has(e.to))
		.map((e) => ({ edge: e.id, a: e.from, b: e.to }));
}

function collectIds(nodes: readonly PrimeNode[], into = new Set<string>()): Set<string> {
	for (const n of nodes) {
		into.add(n.id);
		collectIds(n.children, into);
	}
	return into;
}

export function buildPrime(ws: WsView, config: RootsConfig, scope: NodeRecord | null): PrimeData {
	const roots = scope ? [scope] : primeAnchors(ws.graph);
	const tree = servesForest(ws.graph, roots, isLive).map((t) => toPrimeNode(ws, t));
	const live = ws.graph.nodes.filter(isLive);
	return {
		project: config.project,
		tier: effectiveTier(config),
		questionsPerSession: config.limits.questionsPerSession,
		scope: scope?.id ?? null,
		ideas: live.length,
		committed: live.filter((n) => n.status === "committed").length,
		serves: scope ? upward(ws.graph, scope) : [],
		tree,
		tensions: tensions(ws.graph, scope ? collectIds(tree) : null),
		overrides: live
			.filter((n) => typeof n.tier === "number")
			.map((n) => ({ id: n.id, slug: n.slug, tier: n.tier ?? 0 })),
	};
}

// ── Markdown ──────────────────────────────────────────────────────────────

function treeLines(nodes: readonly PrimeNode[], depth = 0): string[] {
	const pad = "  ".repeat(depth);
	const lines: string[] = [];
	for (const n of nodes) {
		if (n.ref) {
			lines.push(`${pad}- ${n.id} ${n.slug} (see above)`);
			continue;
		}
		const tier = n.tier === undefined ? "" : ` · tier ${n.tier}`;
		lines.push(`${pad}- ${n.id} ${n.slug} [${n.status}${tier}]: ${n.statement || "(empty)"}`);
		const e = n.endorses;
		if (e) {
			const changed = e.changed ? "; sprout changed since" : "";
			lines.push(
				`${pad}  endorses ${e.sprout} ([agent] text a human accepted${changed}): ${e.statement}`,
			);
		}
		lines.push(...treeLines(n.children, depth + 1));
	}
	return lines;
}

function slugOf(graph: Graph, id: string): string {
	return findNode(graph, id)?.slug ?? id;
}

// Keep this list to commands that exist.
const AGENT_COMMANDS: readonly [string, string][] = [
	["roots context <id>", "one idea in full: prose, neighbors, prior + dismissed questions"],
	["roots show <id> · roots list · roots queue · roots log <id>", "read the graph"],
	['roots ask <id> "<question>" --as agent:<model>', "queue a question for the human (tier ≥ 1)"],
	[
		'roots propose edge <a> <b> <serves|tension|replaces> --reason "<why>" --cite <a>:<quote> --cite <b>:<quote> --as agent:<model>',
		"propose a link (tier ≥ 2); quotes are exact substrings of each idea",
	],
	[
		"roots propose split <id> | merge <a> <b> | compost <id> --reason ... --cite <id>:<quote>",
		"propose restructuring (tier ≥ 2); a human decides in `roots tend`",
	],
	[
		'roots sprout "<one-line claim>" [--file <md>] --as agent:<model>',
		"propose a new idea in the agent tree (tier ≥ 2); a human adopts it in their own words or rejects it",
	],
	[
		"roots note <id> --file <path> [--name <n>] --as agent:<model>",
		"attach an artifact (research, diagram) under .roots/agent/notes/ (tier ≥ 1)",
	],
	[
		"roots drift [--diff <rev>]",
		"ideas your changes touch; ask whether each still holds (tier 3; the Stop hook runs it)",
	],
];

const TIER_RULES: readonly [number, string][] = [
	[0, "off: nothing; only deterministic questions"],
	[1, "ask: `roots ask`, `roots note`"],
	[2, "propose: tier 1 + proposals and sprouts"],
	[3, "observe: tier 2 + `roots drift` from harness hooks on repo activity"],
];

function guideLines(d: PrimeData): string[] {
	const lines = [
		"",
		"## Using roots as an agent",
		"",
		"- Human ideas live in `.roots/human/`. Never create, edit or delete files there, and never",
		"  pass `--as human:*`. Humans write intent; you ask questions and (at tier ≥ 2) propose.",
		"- Identify yourself on every write: `--as agent:<model>` or `ROOTS_AGENT=agent:<model>`.",
		"- Ask questions specific to one idea; never generic ones. Read `roots context <id>` first:",
		"  dismissed questions there are ones the human refused.",
		`- Each idea takes at most ${d.questionsPerSession} open agent questions (limits.questionsPerSession).`,
		"- Proposals must cite the human's own words. Rejected proposals are permanent: never refile",
		"  them (`roots context <id>` lists them). Nothing you propose is linked until a human accepts.",
		"- Every command accepts `--json`.",
		"",
		...AGENT_COMMANDS.map(([cmd, what]) => `- \`${cmd}\`: ${what}`),
		"",
		`Agent tier: ${d.tier.tier} (${d.tier.name}). Tiers widen what you may suggest, never what you may write:`,
		...TIER_RULES.map(
			([t, rule]) => `- ${t} ${rule}${t === d.tier.tier ? "  ← this project" : ""}`,
		),
	];
	if (d.overrides.length > 0) {
		lines.push("", "Per-idea overrides (these win over the project tier):");
		for (const o of d.overrides) lines.push(`- ${o.id} ${o.slug}: tier ${o.tier}`);
	}
	return lines;
}

function graphLines(ws: WsView, d: PrimeData): string[] {
	const title = d.scope
		? `## Scope: ${d.scope}`
		: "## Intent (anchors first; nested ideas serve the one above)";
	const lines = ["", title, ""];
	if (d.serves.length > 0) {
		lines.push(`Serves: ${d.serves.map((s) => `${s.id} ${s.slug}`).join(" → ")}`, "");
	}
	lines.push(...(d.tree.length > 0 ? treeLines(d.tree) : ["(no ideas yet)"]));
	if (d.tensions.length > 0) {
		lines.push("", "## Tensions", "");
		for (const t of d.tensions) {
			lines.push(`- ${t.a} ${slugOf(ws.graph, t.a)} ↔ ${t.b} ${slugOf(ws.graph, t.b)}`);
		}
	}
	return lines;
}

export function renderPrimeMarkdown(ws: WsView, d: PrimeData): string {
	const lines = [
		"# Roots: project intent",
		"",
		"> Humans write ideas; agents ask questions and propose structure. Agents never write human intent.",
		"> Only `committed` ideas are intent the human stands behind; `planted`/`shaping` are in progress.",
		"",
		`Project: ${d.project} · ${d.ideas} ideas (${d.committed} committed) · agent tier ${d.tier.tier} (${d.tier.name})`,
		...graphLines(ws, d),
		...guideLines(d),
	];
	return `${lines.join("\n")}\n`;
}
