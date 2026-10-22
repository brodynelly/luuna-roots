// Creating a node (idea or sprout) inside a locked graph update: pick a free
// hex + slug, write the prose file, push the node record. Shared by `plant`,
// `adopt` (ideas, human, TTY) and `sprout` (agent). Sprout files go through
// boundary.ts so an agent write can never land outside .luuna/roots/agent/.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentWriteExclusive } from "./boundary.ts";
import { ConflictError, GuardError, UsageError } from "./errors.ts";
import { generateId, hexSet } from "./ids.ts";
import { proseFileName, type RootsPaths } from "./paths.ts";
import { canonicalNodeDir, scanNodeDirs } from "./prose.ts";
import { isValidSlug, slugify, uniqueSlug } from "./slug.ts";
import { isoNow } from "./time.ts";
import type { Actor, Graph, NodeKind, NodeRecord, NodeStatus } from "./types.ts";

export function chooseSlug(graph: Graph, statement: string, requested: string | undefined): string {
	const taken = new Set(graph.nodes.map((n) => n.slug));
	if (requested !== undefined) {
		if (!isValidSlug(requested)) {
			throw new UsageError(
				`invalid slug "${requested}" (try "${slugify(requested) || "my-idea"}")`,
			);
		}
		if (taken.has(requested)) throw new ConflictError(`slug "${requested}" is already in use`);
		return requested;
	}
	return uniqueSlug(slugify(statement) || "idea", taken);
}

/** Hex values in use by nodes, edges and node directories (ideas and sprouts share one namespace). */
export function takenHex(paths: RootsPaths, graph: Graph): Set<string> {
	const taken = hexSet([...graph.nodes, ...graph.edges].map((r) => r.id));
	const dirs = scanNodeDirs(paths);
	for (const hex of [...dirs.idea.keys(), ...dirs.sprout.keys()]) taken.add(hex);
	return taken;
}

export interface NewNode {
	kind: NodeKind;
	text: string;
	statement: string;
	slug?: string;
	by: Actor;
	status: NodeStatus;
	now?: Date;
	/** Extra node fields (e.g. a sprout's expiresAt). */
	extra?: Partial<NodeRecord>;
}

/**
 * Create the node + prose file. Call inside updateGraph(); pushes the node
 * onto `graph` and returns it with the absolute prose file path.
 */
export function createNode(
	paths: RootsPaths,
	graph: Graph,
	input: NewNode,
): { node: NodeRecord; file: string } {
	const want = input.kind === "idea" ? "human:" : "agent:";
	if (!input.by.startsWith(want)) {
		throw new GuardError(
			`a${input.kind === "idea" ? "n idea" : " sprout"} is authored by ${want}*`,
		);
	}
	const now = isoNow(input.now);
	const node: NodeRecord = {
		type: "node",
		id: generateId(input.kind === "idea" ? "r" : "s", takenHex(paths, graph)),
		kind: input.kind,
		slug: chooseSlug(graph, input.statement, input.slug),
		status: input.status,
		author: input.by,
		createdAt: now,
		updatedAt: now,
		...input.extra,
	};
	const file = join(canonicalNodeDir(paths, node), proseFileName(node.kind));
	if (node.kind === "sprout") {
		agentWriteExclusive(paths, file, input.text);
	} else {
		mkdirSync(canonicalNodeDir(paths, node), { recursive: true });
		writeFileSync(file, input.text, { flag: "wx" });
	}
	graph.nodes.push(node);
	return { node, file };
}
