// The agent side of a think session (tier ≥ 1, see agent-phase.ts): the
// question run before the session (blocking for `luuna-roots think`, background for
// `luuna-roots flow`), the one-line screen notice, the session-end proposal run and
// the research run for questions delegated with [a] (delegation.ts).
// A failed or slow agent never blocks thinking.

import {
	type AgentPhase,
	agentNotice,
	askedIn,
	runAgentPhase,
	runProposalPhase,
	startAgentPhase,
} from "./agent-phase.ts";
import { agentActorFor } from "./agent-runner.ts";
import type { RootsConfig } from "./config.ts";
import { delegationPending, runDelegation } from "./delegation.ts";
import type { ChangedLine } from "./diff.ts";
import type { RootsPaths } from "./paths.ts";
import type { StatusLine } from "./spinner.ts";
import type { Actor, Graph, NodeRecord } from "./types.ts";

/** Agent work still running after a call returned. `done` never rejects. */
export interface BackgroundJob {
	label: string;
	/** Resolves with a one-line problem report, or null when all went well. */
	done: Promise<string | null>;
}

export interface SessionAgentSummary {
	mode: AgentPhase["mode"];
	tier: number;
	actor: Actor | null;
	/** Run status; "background" when the run was handed off (flow). */
	status: string | null;
	error: string | null;
	/** Asked by agent.command for this session. */
	asked: number;
	/** Agent questions queued live during the session. */
	arrived: number;
}

export interface SessionProposalSummary {
	actor: Actor;
	status: string;
	error: string | null;
	filed: string[];
}

/** The ThinkDeps fields the agent steps use. */
export interface ThinkAgentDeps {
	paths: RootsPaths;
	config: RootsConfig;
	node: NodeRecord;
	env?: Record<string, string | undefined>;
	agentStatus?: (text: string) => StatusLine;
	agentTimeoutMs?: number;
	background?: (job: BackgroundJob) => void;
}

/** The pre-session agent step: awaited, or handed to `deps.background`. */
export async function sessionAgentPhase(
	deps: ThinkAgentDeps,
	graph: Graph,
	session: string,
): Promise<AgentPhase> {
	const input = {
		paths: deps.paths,
		config: deps.config,
		node: deps.node,
		graph,
		session,
		env: deps.env ?? {},
		status: deps.agentStatus,
		timeoutMs: deps.agentTimeoutMs,
	};
	if (!deps.background) return runAgentPhase(input);
	const started = startAgentPhase({ ...input, status: undefined });
	if (started.phase.mode === "command") {
		deps.background({
			label: `${started.phase.actor} asking about ${deps.node.slug}`,
			done: started.done.then((p) =>
				p.run && p.run.status !== "ok" ? `agent.command ${p.run.error}` : null,
			),
		});
	}
	return started.phase;
}

export function phaseNotice(deps: ThinkAgentDeps, phase: AgentPhase): string | null {
	if (!deps.background || phase.mode !== "command") return agentNotice(phase);
	return `asking ${phase.actor} for questions; they show up here as they arrive`;
}

export function summarizeAgent(
	deps: ThinkAgentDeps,
	phase: AgentPhase,
	session: string,
	arrived: number,
): SessionAgentSummary {
	const handedOff = Boolean(deps.background) && phase.mode === "command";
	return {
		mode: phase.mode,
		tier: phase.tier.tier,
		actor: phase.actor,
		status: handedOff ? "background" : (phase.run?.status ?? null),
		error: phase.run?.error ?? null,
		asked: handedOff ? askedIn(deps.paths, deps.node.id, session) : phase.asked,
		arrived,
	};
}

/** Session-end agent proposals for what changed (tier ≥ 2); null when skipped. */
export async function sessionProposals(
	deps: ThinkAgentDeps,
	session: string,
	changed: ChangedLine[],
): Promise<SessionProposalSummary | null> {
	const phase = await runProposalPhase({
		paths: deps.paths,
		config: deps.config,
		node: deps.node,
		session,
		changed,
		env: deps.env ?? {},
		status: deps.agentStatus,
		timeoutMs: deps.agentTimeoutMs,
	});
	if (!phase) return null;
	return {
		actor: phase.actor,
		status: phase.run.status,
		error: phase.run.error,
		filed: phase.filed,
	};
}

export interface SessionDelegationSummary {
	actor: Actor;
	/** Run status; "background" when handed to the caller (flow). */
	status: string;
	error: string | null;
	questions: string[];
	found: string[];
	returned: string[];
}

/**
 * Research for delegated questions, after session.end: awaited (with the
 * status line), or handed to `deps.background`. Null when nothing is delegated
 * or there is no agent.command (a harness may pick them up).
 */
export async function sessionDelegation(
	deps: ThinkAgentDeps,
	session: string,
): Promise<SessionDelegationSummary | null> {
	const pending = delegationPending(deps.paths, deps.config, deps.node);
	if (pending.length === 0) return null;
	const input = {
		paths: deps.paths,
		config: deps.config,
		node: deps.node,
		session,
		env: deps.env ?? {},
		timeoutMs: deps.agentTimeoutMs,
	};
	const questions = pending.map((q) => q.id);
	if (deps.background) {
		const n = questions.length;
		deps.background({
			label: `researching ${n} question${n === 1 ? "" : "s"} on ${deps.node.slug}`,
			done: runDelegation(input).then((r) => {
				if (!r) return null;
				if (r.run.status !== "ok") return `agent.command ${r.run.error}`;
				return r.returned.length > 0 ? `${r.returned.join(", ")} came back without findings` : null;
			}),
		});
		const actor = agentActorFor(deps.config.agent.command ?? "agent");
		return { actor, status: "background", error: null, questions, found: [], returned: [] };
	}
	const r = await runDelegation({ ...input, status: deps.agentStatus });
	if (!r) return null;
	return {
		actor: r.actor,
		status: r.run.status,
		error: r.run.error,
		questions: r.questions,
		found: r.found,
		returned: r.returned,
	};
}
