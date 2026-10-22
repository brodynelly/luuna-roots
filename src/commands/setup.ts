// luuna-roots setup claude [--project|--user] [--remove] [--dry-run]: wire roots
// into Claude Code's hooks (roots-ecaa).
//
//   SessionStart  luuna-roots prime --hook   (quiet outside a roots project)
//   PreToolUse    luuna-roots guard          (Write|Edit|MultiEdit|NotebookEdit|Bash)
//   Stop          luuna-roots drift --diff HEAD   (tier 3, once `drift` exists)
//
// --project (default) edits <project>/.claude/settings.json (the roots
// project root, else the current directory); --user edits
// ~/.claude/settings.json. Idempotent; unrelated settings and hooks are kept.
// --remove takes out only roots handlers, and refuses to run inside an agent
// session (ROOTS_AGENT or CLAUDECODE set): an agent must not switch off its
// own guard. Mirrors ../mulch `setup claude` (identify our hooks by command).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flagBool } from "../args.ts";
import {
	desiredHooks,
	installedRootsHooks,
	type MergeResult,
	type RootsHookSpec,
	SettingsShapeError,
	syncRootsHooks,
} from "../claude-settings.ts";
import { loadConfig } from "../config.ts";
import { GuardError, UsageError, ValidationError } from "../errors.ts";
import { refuseAgentSession } from "../guard.ts";
import type { Io } from "../io.ts";
import type { Output } from "../output.ts";
import { findProjectRoot, rootsPaths } from "../paths.ts";
import type { CommandDef } from "../registry.ts";
import { atomicWrite } from "../store.ts";
import { driftCommand } from "./drift.ts";

export const SETUP_TARGETS = ["claude"] as const;

type Scope = "project" | "user";

function scopeOf(flags: { project: boolean; user: boolean }): Scope {
	if (flags.project && flags.user) throw new UsageError("pass --project or --user, not both");
	return flags.user ? "user" : "project";
}

function settingsPath(io: Io, scope: Scope): string {
	if (scope === "user") {
		const home = io.env.HOME;
		if (!home) throw new UsageError("--user needs $HOME to find ~/.claude/settings.json");
		return join(home, ".claude", "settings.json");
	}
	return join(findProjectRoot(io.cwd) ?? io.cwd, ".claude", "settings.json");
}

function readSettings(file: string): Record<string, unknown> {
	if (!existsSync(file)) return {};
	const raw = readFileSync(file, "utf8");
	if (raw.trim() === "") return {};
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		throw new ValidationError(`cannot parse ${file} (${why}); fix it by hand, nothing was written`);
	}
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		throw new ValidationError(`${file} is not a JSON object; nothing was written`);
	}
	return v as Record<string, unknown>;
}

function projectTier(io: Io): number | null {
	const root = findProjectRoot(io.cwd);
	return root ? loadConfig(rootsPaths(root)).tier : null;
}

function refuseAgentRemove(io: Io): void {
	refuseAgentSession(io, "setup claude --remove");
	if (io.env.CLAUDECODE) {
		throw new GuardError(
			"`luuna-roots setup claude --remove` would switch off the guard, and this looks like a Claude Code session (CLAUDECODE is set); run it yourself in a terminal",
		);
	}
}

function describe(h: RootsHookSpec): string {
	return `${h.event}${h.matcher ? ` [${h.matcher}]` : ""}: ${h.command}`;
}

interface SetupOptions {
	scope: Scope;
	remove: boolean;
	dryRun: boolean;
}

interface SetupPlan {
	file: string;
	merged: MergeResult;
	text: string;
}

function planSetup(io: Io, opts: SetupOptions): SetupPlan {
	if (opts.remove) refuseAgentRemove(io);
	const file = settingsPath(io, opts.scope);
	const before = readSettings(file);
	const tier = opts.scope === "project" ? projectTier(io) : null;
	const wanted = opts.remove
		? []
		: desiredHooks({ tier, hasCommand: (n) => n === driftCommand.name });
	try {
		const merged = syncRootsHooks(before, wanted);
		return { file, merged, text: `${JSON.stringify(merged.settings, null, 2)}\n` };
	} catch (err) {
		if (!(err instanceof SettingsShapeError)) throw err;
		throw new ValidationError(`${file}: ${err.message}; nothing was written`);
	}
}

async function report(out: Output, target: string, opts: SetupOptions, plan: SetupPlan) {
	const { file, merged } = plan;
	const hooks = installedRootsHooks(merged.settings);
	await out.result({
		target,
		scope: opts.scope,
		path: file,
		action: opts.remove ? "remove" : "install",
		changed: merged.changed,
		dryRun: opts.dryRun,
		hooks,
		...(opts.dryRun ? { settings: merged.settings } : {}),
	});
	if (opts.dryRun) {
		await out.line(out.c.dim(`# ${file} (dry run, not written)`));
		await out.line(plan.text.trimEnd());
		return;
	}
	const verb = opts.remove ? "removed roots hooks from" : "installed roots hooks in";
	if (!merged.changed) await out.info(`${file}: already up to date`);
	else await out.success(`${verb} ${file}`);
	for (const h of hooks) await out.info(`  ${describe(h)}`);
}

export const setupCommand: CommandDef = {
	name: "setup",
	group: "setup",
	summary: "Install harness hooks (claude): prime on start, guard on edits",
	usage: "setup claude [--project|--user] [--remove] [--dry-run]",
	description:
		"Merges roots hooks into .claude/settings.json (project, default) or\n" +
		"~/.claude/settings.json (--user): SessionStart `luuna-roots prime --hook`, PreToolUse\n" +
		"`luuna-roots guard` on Write|Edit|MultiEdit|NotebookEdit|Bash, and at tier 3 a Stop hook\n" +
		"`luuna-roots drift --diff HEAD` (when available). Re-running is a no-op; other settings\n" +
		"and hooks are kept. --remove takes out only roots hooks.",
	flags: {
		project: { type: "boolean", description: "Edit <project>/.claude/settings.json (default)" },
		user: { type: "boolean", description: "Edit ~/.claude/settings.json" },
		remove: { type: "boolean", description: "Remove roots hooks" },
		"dry-run": { type: "boolean", description: "Show the result; write nothing" },
	},
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		const target = args[0] ?? "";
		if (!(SETUP_TARGETS as readonly string[]).includes(target)) {
			throw new UsageError(
				`unknown setup target "${target}"; supported: ${SETUP_TARGETS.join(", ")}`,
			);
		}
		const opts: SetupOptions = {
			scope: scopeOf({ project: flagBool(flags, "project"), user: flagBool(flags, "user") }),
			remove: flagBool(flags, "remove"),
			dryRun: flagBool(flags, "dry-run"),
		};
		const plan = planSetup(io, opts);
		if (plan.merged.changed && !opts.dryRun) await atomicWrite(plan.file, plan.text);
		await report(out, target, opts, plan);
	},
};
