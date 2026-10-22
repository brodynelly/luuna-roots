// The human/agent boundary on disk (roots-031e; guard 2).
//
// Every file an agent command writes (`sprout`, `note`) goes through
// agentMkdir() / agentWriteExclusive(), which refuse any target that:
//   - is not lexically inside .luuna/roots/agent/ (path traversal, absolute paths)
//   - is lexically inside .luuna/roots/human/
//   - has a symlink anywhere between .luuna/roots/agent/ and the target (a link
//     planted to redirect writes elsewhere, e.g. into human/)
//   - resolves (realpath of the deepest existing ancestor) outside
//     .luuna/roots/agent/ or inside .luuna/roots/human/
// Files are created with O_EXCL ("wx"), which never follows a symlink at the
// final component. This covers accidental mixing, not a malicious actor with
// shell access (SECURITY.md).

import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { GuardError } from "./errors.ts";
import type { RootsPaths } from "./paths.ts";

/** True when `p` is `parent` or inside it (lexical; both absolute). */
export function isInside(parent: string, p: string): boolean {
	const rel = relative(resolve(parent), resolve(p));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `p` (absolute, or relative to the project root) is under .luuna/roots/human/. */
export function isHumanPath(paths: RootsPaths, p: string): boolean {
	const abs = isAbsolute(p) ? p : resolve(paths.root, p);
	if (isInside(paths.human, abs)) return true;
	const real = realAncestor(abs);
	return real !== null && isInside(realOrSelf(paths.human), real);
}

export function realOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** realpath of the deepest existing ancestor of `p` (inclusive), or null. */
function realAncestor(p: string): string | null {
	let cur = resolve(p);
	for (;;) {
		if (existsSync(cur)) return realOrSelf(cur);
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function refuse(target: string, why: string): never {
	throw new GuardError(
		`refusing to write ${target}: ${why} (agents write only under .luuna/roots/agent/)`,
	);
}

/** Throw a GuardError unless an agent may write `target` (a file or directory path). */
export function assertAgentWritable(paths: RootsPaths, target: string): void {
	const abs = resolve(target);
	if (isInside(paths.human, abs)) refuse(target, "it is inside .luuna/roots/human/");
	if (!isInside(paths.agent, abs) || abs === resolve(paths.agent)) {
		refuse(target, "it is outside .luuna/roots/agent/");
	}
	// Every existing component from .luuna/roots/agent down to the target: no symlinks.
	const parts = relative(paths.agent, abs).split(sep);
	let cur = paths.agent;
	if (isSymlink(cur)) refuse(target, ".luuna/roots/agent is a symlink");
	for (const part of parts) {
		cur = resolve(cur, part);
		if (isSymlink(cur)) refuse(target, `${relative(paths.root, cur)} is a symlink`);
	}
	const real = realAncestor(abs);
	if (real === null || !isInside(realOrSelf(paths.agent), real)) {
		refuse(target, "it resolves outside .luuna/roots/agent/");
	}
	if (isInside(realOrSelf(paths.human), real)) refuse(target, "it resolves into .luuna/roots/human/");
}

/** mkdir -p under .luuna/roots/agent/ with the boundary checked before and after. */
export function agentMkdir(paths: RootsPaths, dir: string): void {
	assertAgentWritable(paths, dir);
	mkdirSync(dir, { recursive: true });
	assertAgentWritable(paths, dir);
}

/** Create a new file under .luuna/roots/agent/ (never overwrites, never follows a final symlink). */
export function agentWriteExclusive(
	paths: RootsPaths,
	file: string,
	data: string | Uint8Array,
): void {
	agentMkdir(paths, dirname(file));
	assertAgentWritable(paths, file);
	writeFileSync(file, data, { flag: "wx" });
}
