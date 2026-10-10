// Endorsed ideas (roots-6205): an idea adopted with `adopt --endorse` or tend
// [t]. Its idea.md holds only the human's thoughts; the agent text the human
// accepted is the sprout's sprout.md, pinned by hash at adoption
// (NodeRecord.endorses). Readers (view, show, prime, context) show that text
// quoted and labeled as the agent's, never as human prose. Read-only.
// The endorsed statement is the idea's claim (roots-9699): list, view
// headings, prime, rules and citations use it; idea.md renders as the
// human's thoughts.

import { findNode } from "./graph.ts";
import type { RootsPaths } from "./paths.ts";
import { contentHash, type NodeDirs, type NodeProse, readNodeProse } from "./prose.ts";
import type { Actor, Graph, NodeRecord } from "./types.ts";

export interface Endorsed {
	sprout: string;
	slug: string;
	/** The sprout's author (agent:*). */
	by: Actor;
	statement: string;
	body: string;
	/** sprout.md is missing or no longer matches the hash pinned at endorsement. */
	changed: boolean;
}

/** The agent text an endorsed idea stands on, or null for other ideas. */
export function readEndorsed(
	paths: RootsPaths,
	graph: Graph,
	idea: Pick<NodeRecord, "endorses">,
	dirs?: NodeDirs,
): Endorsed | null {
	const e = idea.endorses;
	if (!e) return null;
	const sprout = findNode(graph, e.sprout);
	if (!sprout) {
		return { sprout: e.sprout, slug: "", by: "agent:?", statement: "", body: "", changed: true };
	}
	const prose = readNodeProse(paths, sprout, dirs);
	return {
		sprout: sprout.id,
		slug: sprout.slug,
		by: sprout.author,
		statement: prose.statement,
		body: prose.body,
		changed: !prose.exists || contentHash(prose.text) !== e.hash,
	};
}

/** One-line label: whose text it is and that a human endorsed it. */
export function endorsedLabel(e: Endorsed, endorsedBy?: Actor): string {
	const who = `[agent] ${e.by.replace(/^agent:/, "")}`;
	const human = endorsedBy ? ` · endorsed by ${endorsedBy}` : " · endorsed";
	const changed = e.changed ? " · CHANGED since endorsement" : "";
	return `${who} · ${e.sprout}${human}${changed}`;
}

/** Markdown block: the label, then the agent text as a blockquote. */
export function endorsedMarkdown(e: Endorsed, endorsedBy?: Actor): string[] {
	const text = e.body ? `${e.statement}\n\n${e.body}` : e.statement;
	const quoted = (text || "(sprout.md missing)")
		.split("\n")
		.map((l) => (l === "" ? ">" : `> ${l}`));
	return [`> _${endorsedLabel(e, endorsedBy)}_`, ">", ...quoted];
}

/**
 * The claim an idea stands for (roots-9699). For an endorsed idea it is the
 * endorsed agent statement, and idea.md is the human's thoughts on it; for
 * any other node it is the node's own statement.
 */
export function claimStatement(own: string, e: Endorsed | null): string {
	return e?.statement || own;
}

/**
 * Text that rules judge and citations quote: for an endorsed idea, the
 * endorsed agent text followed by the human's thoughts.
 */
export function claimText(own: string, e: Endorsed | null): string {
	if (!e?.statement) return own;
	return [e.statement, e.body, own].filter((p) => p.trim() !== "").join("\n\n");
}

export interface Claim {
	prose: NodeProse;
	endorsed: Endorsed | null;
	statement: string;
	text: string;
}

/** A node's prose with its claim resolved (see claimStatement/claimText). */
export function readClaim(
	paths: RootsPaths,
	graph: Graph,
	node: Pick<NodeRecord, "id" | "kind" | "slug" | "endorses">,
	dirs?: NodeDirs,
): Claim {
	const prose = readNodeProse(paths, node, dirs);
	const endorsed = readEndorsed(paths, graph, node, dirs);
	return {
		prose,
		endorsed,
		statement: claimStatement(prose.statement, endorsed),
		text: claimText(prose.text, endorsed),
	};
}
