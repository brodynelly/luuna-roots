// luuna-roots init: create .luuna/roots/ in the current directory.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isHumanActor, resolveHumanActor, rootsActor } from "../actor.ts";
import { defaultConfig, renderInitialConfig } from "../config.ts";
import { ConflictError } from "../errors.ts";
import { appendEvent, makeEvent } from "../events.ts";
import type { Io } from "../io.ts";
import { ROOTS_DIR, type RootsPaths, rootsPaths } from "../paths.ts";
import type { CommandDef } from "../registry.ts";

export const GITATTRIBUTES_LINE = ".luuna/roots/*.jsonl merge=union";
export const ROOTS_GITIGNORE = "*.lock\n*.tmp.*\n";

/** Append the union-merge rule to <root>/.gitattributes. Returns true if added. */
export function ensureGitattributes(root: string): boolean {
	const file = join(root, ".gitattributes");
	const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (existing.split(/\r?\n/).some((l) => l.trim() === GITATTRIBUTES_LINE)) return false;
	const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
	writeFileSync(file, `${existing}${sep}${GITATTRIBUTES_LINE}\n`);
	return true;
}

function createLayout(paths: RootsPaths, project: string): string[] {
	const created: string[] = [];
	for (const dir of [paths.dir, paths.human, paths.sprouts, paths.notes]) {
		if (!existsSync(dir)) created.push(dir);
		mkdirSync(dir, { recursive: true });
	}
	const files: [string, string][] = [
		[paths.config, renderInitialConfig(defaultConfig(project))],
		[paths.graph, ""],
		[paths.proposals, ""],
		[paths.questions, ""],
		[paths.events, ""],
		[paths.gitignore, ROOTS_GITIGNORE],
	];
	for (const [file, content] of files) {
		if (existsSync(file)) continue;
		writeFileSync(file, content, { flag: "wx" });
		created.push(file);
	}
	return created;
}

function initActor(io: Io): string {
	try {
		const actor = resolveHumanActor(io);
		return isHumanActor(actor) ? actor : rootsActor();
	} catch {
		return rootsActor();
	}
}

export const initCommand: CommandDef = {
	name: "init",
	group: "setup",
	summary: "Initialize .luuna/roots/ in the current directory",
	usage: "init",
	description:
		"Creates .luuna/roots/ (config.yaml, JSONL stores, human/ and agent/ trees) and adds\n" +
		`\`${GITATTRIBUTES_LINE}\` to .gitattributes. Fails if already initialized.`,
	maxArgs: 0,
	async run({ io, out }) {
		const paths = rootsPaths(io.cwd);
		if (existsSync(paths.config)) {
			throw new ConflictError(`already initialized: ${paths.dir}`, { path: paths.dir });
		}
		const created = createLayout(paths, basename(paths.root) || "project");
		const gitattributes = ensureGitattributes(paths.root);
		await appendEvent(paths, makeEvent("init", initActor(io), { project: basename(paths.root) }));
		await out.result({
			path: ROOTS_DIR,
			root: paths.root,
			created: created.map((p) => p.slice(paths.root.length + 1)),
			gitattributes: gitattributes ? "added" : "present",
		});
		await out.success(`initialized ${ROOTS_DIR}/ in ${paths.root}`);
		if (gitattributes) await out.info(`  added \`${GITATTRIBUTES_LINE}\` to .gitattributes`);
		await out.info(`  next: luuna-roots plant "<one sentence of intent>"`);
	},
};
