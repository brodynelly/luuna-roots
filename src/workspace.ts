// Open a roots project for a command: locate .luuna/roots/, reconcile node
// directories the human renamed by hand, and load the graph.
//
// Directory fix-up (roots-4143): if `.luuna/roots/human/a1b2-offline-sync`
// was renamed in the shell to `a1b2-sync-offline`, the next read finds it by
// hex prefix and updates the node's slug to `sync-offline`, logging an `mv`
// event by `roots:dir-rename`. Fix-up only writes graph.jsonl/events.jsonl,
// never anything under human/.

import { appendEvent, makeEvent } from "./events.ts";
import { readGraph, updateGraph } from "./graph.ts";
import { type RootsPaths, requireRootsPaths } from "./paths.ts";
import { dirCandidates, dirNameFor, dirSlug, type NodeDirs, scanNodeDirs } from "./prose.ts";
import { isValidSlug } from "./slug.ts";
import { isoNow } from "./time.ts";
import type { Graph, NodeRecord } from "./types.ts";

export const DIR_RENAME_ACTOR = "roots:dir-rename";

export interface SlugFix {
	id: string;
	oldSlug: string;
	newSlug: string;
	dir: string;
}

export interface Workspace {
	paths: RootsPaths;
	graph: Graph;
	dirs: NodeDirs;
	fixes: SlugFix[];
}

/** The slug a node should take from its on-disk directory, or null if none/unclear. */
function slugFromDisk(node: NodeRecord, dirs: NodeDirs, graph: Graph): SlugFix | null {
	const names = dirCandidates(dirs, node);
	if (names.length !== 1 || names.includes(dirNameFor(node))) return null;
	const dir = names[0] ?? "";
	const slug = dirSlug(dir);
	if (!isValidSlug(slug) || slug === node.slug) return null;
	if (graph.nodes.some((n) => n.id !== node.id && n.slug === slug)) return null;
	return { id: node.id, oldSlug: node.slug, newSlug: slug, dir };
}

export function detectSlugFixes(graph: Graph, dirs: NodeDirs): SlugFix[] {
	const fixes: SlugFix[] = [];
	for (const node of graph.nodes) {
		const fix = slugFromDisk(node, dirs, graph);
		if (fix) fixes.push(fix);
	}
	return fixes;
}

/** Apply directory-name fix-ups under the graph lock. Returns what changed. */
export async function reconcileDirs(paths: RootsPaths): Promise<SlugFix[]> {
	const fixes = await updateGraph(paths, (graph) => {
		const found = detectSlugFixes(graph, scanNodeDirs(paths));
		const at = isoNow();
		for (const fix of found) {
			const node = graph.nodes.find((n) => n.id === fix.id);
			if (!node) continue;
			node.slug = fix.newSlug;
			node.updatedAt = at;
		}
		return { write: found.length > 0, result: found };
	});
	for (const fix of fixes) {
		await appendEvent(
			paths,
			makeEvent("mv", DIR_RENAME_ACTOR, {
				node: fix.id,
				oldSlug: fix.oldSlug,
				newSlug: fix.newSlug,
				dir: fix.dir,
			}),
		);
	}
	return fixes;
}

/**
 * Locate the project from `cwd`, apply directory fix-ups, and load the graph.
 * Throws NotInitializedError when there is no .luuna/roots/.
 */
export async function openWorkspace(cwd: string): Promise<Workspace> {
	const paths = requireRootsPaths(cwd);
	const needsFix = detectSlugFixes(readGraph(paths), scanNodeDirs(paths)).length > 0;
	const fixes = needsFix ? await reconcileDirs(paths) : [];
	return { paths, graph: readGraph(paths), dirs: scanNodeDirs(paths), fixes };
}
