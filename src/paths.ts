// Locating .luuna/roots/ and the files inside it.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NotInitializedError } from "./errors.ts";
import type { NodeKind } from "./types.ts";

export const ROOTS_DIR = ".luuna/roots";

export interface RootsPaths {
	/** Project root: the directory containing .luuna/roots/. */
	root: string;
	/** Absolute path to .luuna/roots/. */
	dir: string;
	config: string;
	graph: string;
	proposals: string;
	questions: string;
	events: string;
	headings: string;
	gitignore: string;
	human: string;
	agent: string;
	sprouts: string;
	notes: string;
}

export function rootsPaths(projectRoot: string): RootsPaths {
	const root = resolve(projectRoot);
	const dir = join(root, ROOTS_DIR);
	return {
		root,
		dir,
		config: join(dir, "config.yaml"),
		graph: join(dir, "graph.jsonl"),
		proposals: join(dir, "proposals.jsonl"),
		questions: join(dir, "questions.jsonl"),
		events: join(dir, "events.jsonl"),
		headings: join(dir, "headings.jsonl"),
		gitignore: join(dir, ".gitignore"),
		human: join(dir, "human"),
		agent: join(dir, "agent"),
		sprouts: join(dir, "agent", "sprouts"),
		notes: join(dir, "agent", "notes"),
	};
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Walk up from `start` to the nearest directory containing `.luuna/roots/`. */
export function findProjectRoot(start: string): string | null {
	let cur = resolve(start);
	while (true) {
		if (isDir(join(cur, ROOTS_DIR)) && existsSync(join(cur, ROOTS_DIR, "config.yaml"))) {
			return cur;
		}
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

export function requireRootsPaths(cwd: string): RootsPaths {
	const root = findProjectRoot(cwd);
	if (!root) throw new NotInitializedError(cwd);
	return rootsPaths(root);
}

/** Parent directory that holds node directories of the given kind. */
export function kindDir(paths: RootsPaths, kind: NodeKind): string {
	return kind === "idea" ? paths.human : paths.sprouts;
}

/** Prose file name inside a node directory. */
export function proseFileName(kind: NodeKind): string {
	return kind === "idea" ? "idea.md" : "sprout.md";
}
