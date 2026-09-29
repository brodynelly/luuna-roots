// Endorsed ideas (roots-6205): an idea adopted with `adopt --endorse` or tend
// [t]. Its idea.md holds only the human's thoughts; the agent text the human
// accepted is the sprout's sprout.md, pinned by hash at adoption
// (NodeRecord.endorses). Readers (view, show, prime, context) show that text
// quoted and labeled as the agent's, never as human prose. Read-only.

import { findNode } from "./graph.ts";
import type { RootsPaths } from "./paths.ts";
import { contentHash, type NodeDirs, readNodeProse } from "./prose.ts";
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
