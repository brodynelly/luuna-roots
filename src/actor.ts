// Actor resolution. Every `by` field uses one of:
//   human:<name>   ROOTS_USER, else `git config user.name`, kebab-cased
//   agent:<model>  --as agent:<model>, else ROOTS_AGENT
//   roots | roots:<rule>   the CLI itself

import { spawnSync } from "node:child_process";
import { GuardError } from "./errors.ts";
import type { Io } from "./io.ts";
import { kebab } from "./slug.ts";
import type { Actor } from "./types.ts";

export type ActorKind = "human" | "agent" | "roots";

export interface ParsedActor {
	kind: ActorKind;
	name: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseActor(actor: string): ParsedActor | null {
	if (actor === "roots") return { kind: "roots", name: "" };
	const colon = actor.indexOf(":");
	if (colon === -1) return null;
	const kind = actor.slice(0, colon);
	const name = actor.slice(colon + 1);
	if (kind !== "human" && kind !== "agent" && kind !== "roots") return null;
	if (!NAME_RE.test(name)) return null;
	return { kind, name };
}

export function isHumanActor(actor: string): boolean {
	return parseActor(actor)?.kind === "human";
}

export function isAgentActor(actor: string): boolean {
	return parseActor(actor)?.kind === "agent";
}

export function rootsActor(rule?: string): Actor {
	return rule ? `roots:${rule}` : "roots";
}

export function gitUserName(io: Pick<Io, "cwd" | "env">): string | null {
	try {
		const r = spawnSync("git", ["config", "user.name"], {
			cwd: io.cwd,
			env: io.env as NodeJS.ProcessEnv,
			encoding: "utf8",
		});
		if (r.status !== 0) return null;
		const name = r.stdout.trim();
		return name === "" ? null : name;
	} catch {
		return null;
	}
}

function humanFromRaw(raw: string, source: string): Actor {
	const colon = raw.indexOf(":");
	if (colon !== -1 && raw.slice(0, colon) !== "human") {
		throw new GuardError(`${source} must be a human name, got "${raw}"`);
	}
	const name = kebab(colon === -1 ? raw : raw.slice(colon + 1));
	if (name === "") throw new GuardError(`${source} does not contain a usable name ("${raw}")`);
	return `human:${name}`;
}

/**
 * Resolve the human actor for a human command. Throws GuardError when no name
 * is available: human commands refuse to run anonymously.
 */
export function resolveHumanActor(io: Pick<Io, "cwd" | "env">): Actor {
	const env = (io.env.LUUNA_ROOTS_USER ?? io.env.ROOTS_USER)?.trim();
	if (env) return humanFromRaw(env, io.env.LUUNA_ROOTS_USER ? "LUUNA_ROOTS_USER" : "ROOTS_USER");
	const git = gitUserName(io);
	if (git) return humanFromRaw(git, "git user.name");
	throw new GuardError(
		"cannot tell who you are: set LUUNA_ROOTS_USER or `git config user.name` (human commands need a name)",
	);
}

/**
 * Resolve the agent actor for an agent command from `--as` or ROOTS_AGENT.
 * A bare model name is accepted and prefixed with `agent:`. `human:*` and
 * `roots*` are refused: agents can never act as a human.
 */
export function resolveAgentActor(asFlag: string | undefined, io: Pick<Io, "env">): Actor {
	const raw = (asFlag ?? io.env.LUUNA_ROOTS_AGENT ?? io.env.ROOTS_AGENT ?? "").trim();
	const source = asFlag !== undefined ? "--as" : io.env.LUUNA_ROOTS_AGENT ? "LUUNA_ROOTS_AGENT" : "ROOTS_AGENT";
	if (raw === "") {
		throw new GuardError(
			"agent commands need an identity: pass --as agent:<model> or set LUUNA_ROOTS_AGENT",
		);
	}
	const candidate = raw.includes(":") ? raw : `agent:${raw}`;
	const parsed = parseActor(candidate);
	if (parsed?.kind === "human") {
		throw new GuardError(`${source}: agents cannot act as a human ("${raw}")`);
	}
	if (parsed?.kind !== "agent") {
		throw new GuardError(`${source}: expected agent:<model>, got "${raw}"`);
	}
	return candidate;
}
