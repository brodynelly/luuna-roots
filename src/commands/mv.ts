// luuna-roots mv <id> <new-slug>: rename a node's slug and directory. The id is stable.

import { existsSync, renameSync } from "node:fs";
import { relative } from "node:path";
import { resolveHumanActor } from "../actor.ts";
import { ConflictError, NotFoundError, UsageError } from "../errors.ts";
import { appendEvent, makeEvent } from "../events.ts";
import { updateGraph } from "../graph.ts";
import type { RootsPaths } from "../paths.ts";
import { canonicalNodeDir, locateNodeDir, scanNodeDirs } from "../prose.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { isValidSlug, slugify } from "../slug.ts";
import { isoNow } from "../time.ts";
import type { NodeRecord } from "../types.ts";
import { openWorkspace } from "../workspace.ts";

export interface MoveResult {
	node: NodeRecord;
	oldSlug: string;
	fromDir: string | null;
	toDir: string;
}

function validateSlug(slug: string): void {
	if (isValidSlug(slug)) return;
	const hint = slugify(slug);
	throw new UsageError(`invalid slug "${slug}"${hint ? ` (try "${hint}")` : ""}; use kebab-case`);
}

/** Rename under the graph lock; the directory rename is rolled back if the write fails. */
export async function moveNode(
	paths: RootsPaths,
	id: string,
	newSlug: string,
): Promise<MoveResult> {
	let renamed: { from: string; to: string } | null = null;
	try {
		return await updateGraph(paths, (graph) => {
			const node = graph.nodes.find((n) => n.id === id);
			if (!node) throw new NotFoundError(`node ${id} disappeared`);
			if (node.slug === newSlug) throw new UsageError(`${id} is already named "${newSlug}"`);
			const clash = graph.nodes.find((n) => n.slug === newSlug);
			if (clash) throw new ConflictError(`slug "${newSlug}" is already used by ${clash.id}`);
			const fromDir = locateNodeDir(paths, node, scanNodeDirs(paths));
			const oldSlug = node.slug;
			node.slug = newSlug;
			node.updatedAt = isoNow();
			const toDir = canonicalNodeDir(paths, node);
			if (fromDir && fromDir !== toDir) {
				if (existsSync(toDir)) throw new ConflictError(`directory already exists: ${toDir}`);
				renameSync(fromDir, toDir);
				renamed = { from: fromDir, to: toDir };
			}
			return { write: true, result: { node, oldSlug, fromDir, toDir } };
		});
	} catch (err) {
		const r = renamed as { from: string; to: string } | null;
		if (r) renameSync(r.to, r.from);
		throw err;
	}
}

export const mvCommand: CommandDef = {
	name: "mv",
	group: "capture",
	summary: "Rename an idea or sprout (the id is stable)",
	usage: "mv <id> <new-slug>",
	description:
		"Renames the directory and updates the slug. Edges reference ids, so no link breaks.",
	minArgs: 2,
	maxArgs: 2,
	async run({ io, out, args }) {
		const by = resolveHumanActor(io);
		const [query = "", newSlug = ""] = args;
		validateSlug(newSlug);
		const ws = await openWorkspace(io.cwd);
		const target = resolveNode(ws.graph.nodes, query);
		const res = await moveNode(ws.paths, target.id, newSlug);
		await appendEvent(
			ws.paths,
			makeEvent("mv", by, { node: target.id, oldSlug: res.oldSlug, newSlug }),
		);
		if (!res.fromDir) out.warn(`no directory found for ${target.id}; updated the slug only`);
		await out.result({
			id: target.id,
			oldSlug: res.oldSlug,
			slug: newSlug,
			path: relative(ws.paths.root, res.toDir),
		});
		await out.success(`renamed ${out.c.id(target.id)} ${res.oldSlug} → ${newSlug}`);
	},
};
