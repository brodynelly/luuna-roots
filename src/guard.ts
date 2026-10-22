// TTY guard for commands that create human content (roots-4143; human/agent
// boundary guard 1). Agents in harnesses have no interactive stdin.
//
// Test-only override: ROOTS_FORCE_TTY=1 is honored ONLY together with
// NODE_ENV=test (set by `bun test`). It exists so the test suite can drive
// human commands; it is not a user-facing feature and agent-facing commands
// never consult it.

import { resolveHumanActor } from "./actor.ts";
import { GuardError } from "./errors.ts";
import type { Io } from "./io.ts";
import type { Actor } from "./types.ts";

export function ttyForcedForTests(env: Io["env"]): boolean {
	return env.ROOTS_FORCE_TTY === "1" && env.NODE_ENV === "test";
}

export function hasInteractiveTty(io: Pick<Io, "env" | "stdinIsTTY">): boolean {
	return io.stdinIsTTY || ttyForcedForTests(io.env);
}

export function requireTty(io: Pick<Io, "env" | "stdinIsTTY">, command: string): void {
	if (hasInteractiveTty(io)) return;
	throw new GuardError(
		`\`roots ${command}\` writes human content and needs an interactive terminal (TTY); agents cannot run it`,
	);
}

/**
 * Human commands that change what agents may do (e.g. `luuna-roots tier`) refuse to
 * run inside an agent session. `think` sets ROOTS_AGENT for the agent.command
 * it spawns, and harnesses set it for their agent, so an agent cannot raise
 * its own permissions by calling a non-interactive human command.
 */
export function refuseAgentSession(io: Pick<Io, "env">, command: string): void {
	const agent = io.env.ROOTS_AGENT?.trim();
	if (!agent) return;
	throw new GuardError(
		`\`roots ${command}\` is a human command, but ROOTS_AGENT is set (${agent}); ` +
			"unset ROOTS_AGENT to run it yourself",
	);
}

/**
 * Guard for non-interactive human structure commands (link, accept, commit,
 * ...): refuse inside an agent session, then resolve the human. No TTY needed.
 */
export function requireHumanCommand(io: Pick<Io, "cwd" | "env">, command: string): Actor {
	refuseAgentSession(io, command);
	return resolveHumanActor(io);
}
