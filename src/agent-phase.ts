// The agent step before a think session (tier ≥ 1). Modes:
//   off      effective tier 0: no agent questions at all (not even queued ones)
//   harness  no agent.command: an already-running harness may `luuna-roots ask`;
//            its questions are picked up at start and live during the session
//   full     the idea already has its cap of open agent questions; skip the run
//   command  run agent.command with the context packet; it calls `luuna-roots ask`
// A failed or slow agent never blocks the session.
//
// At session end (tier ≥ 2, agent.command set, lines changed),
// runProposalPhase() runs agent.command again with the changed lines and the
// other ideas, and an instruction to `luuna-roots propose edge --mention` for fuzzy
// mentions. Those land next to the deterministic mention proposals and
// share a `tend` card with them.

import {
	type AgentRunResult,
	agentActorFor,
	agentEnv,
	agentPrompt,
	runAgentCommand,
} from "./agent-runner.ts";
import type { RootsConfig } from "./config.ts";
import { buildContext, type ContextPacket, renderContextMarkdown } from "./context.ts";
import type { ChangedLine } from "./diff.ts";
import { readGraph } from "./graph.ts";
import { mentionTargets } from "./mention-scan.ts";
import type { RootsPaths } from "./paths.ts";
import { pendingProposals, readProposals } from "./proposals.ts";
import { scanNodeDirs } from "./prose.ts";
import { readQuestions } from "./questions.ts";
import type { StatusLine } from "./spinner.ts";
import { type EffectiveTier, effectiveTier } from "./tier.ts";
import type { Actor, Graph, NodeRecord } from "./types.ts";

export type AgentMode = "off" | "harness" | "full" | "command";

export interface AgentPhase {
	mode: AgentMode;
	tier: EffectiveTier;
	actor: Actor | null;
	run: AgentRunResult | null;
	/** Questions the agent asked for this session during the run. */
	asked: number;
}

export interface AgentPhaseInput {
	paths: RootsPaths;
	config: RootsConfig;
	node: NodeRecord;
	graph: Graph;
	session: string;
	/** Base environment for agent.command (PATH etc.). */
	env: Record<string, string | undefined>;
	status?: (text: string) => StatusLine;
	timeoutMs?: number;
}

export function askedIn(paths: RootsPaths, node: string, session: string): number {
	return readQuestions(paths).filter(
		(q) => q.node === node && q.session === session && q.by.startsWith("agent:"),
	).length;
}

export function agentsAllowed(config: RootsConfig, node: NodeRecord): boolean {
	return effectiveTier(config, node).tier >= 1;
}

interface AgentPlan {
	tier: EffectiveTier;
	mode: AgentMode;
	actor: Actor | null;
	/** Set only in "command" mode: what to send agent.command. */
	run: (() => Promise<AgentRunResult>) | null;
}

function planAgentPhase(input: AgentPhaseInput): AgentPlan {
	const { paths, config, node, session } = input;
	const tier = effectiveTier(config, node);
	const command = config.agent.command;
	if (tier.tier < 1) return { tier, mode: "off", actor: null, run: null };
	if (!command) return { tier, mode: "harness", actor: null, run: null };
	const actor = agentActorFor(command);
	const ws = { paths, graph: input.graph, dirs: scanNodeDirs(paths) };
	const packet = buildContext(ws, config, node, { session });
	if (packet.limits.asksRemaining === 0) return { tier, mode: "full", actor, run: null };
	const run = () =>
		runAgentCommand({
			command,
			cwd: paths.root,
			input: agentPrompt(packet, { actor, asks: packet.limits.asksRemaining }),
			env: agentEnv(input.env, { actor, session, node: node.id }),
			timeoutMs: input.timeoutMs ?? config.agent.timeoutSeconds * 1000,
		});
	return { tier, mode: "command", actor, run };
}

export async function runAgentPhase(input: AgentPhaseInput): Promise<AgentPhase> {
	const plan = planAgentPhase(input);
	const base = { tier: plan.tier, mode: plan.mode, actor: plan.actor, run: null, asked: 0 };
	if (!plan.run) return base;
	const status = input.status?.(`asking ${plan.actor} for questions about ${input.node.slug}…`);
	const run = await plan.run();
	const asked = askedIn(input.paths, input.node.id, input.session);
	status?.stop(
		run.status === "ok" ? undefined : `! agent.command ${run.error}; continuing without it`,
	);
	return { ...base, run, asked };
}

/**
 * Like runAgentPhase, but agent.command runs in the background: the session
 * starts at once and the questions arrive live (think's questions.jsonl
 * watcher). `done` resolves with the finished phase; it never rejects.
 */
export function startAgentPhase(input: AgentPhaseInput): {
	phase: AgentPhase;
	done: Promise<AgentPhase>;
} {
	const plan = planAgentPhase(input);
	const phase: AgentPhase = {
		tier: plan.tier,
		mode: plan.mode,
		actor: plan.actor,
		run: null,
		asked: 0,
	};
	if (!plan.run) return { phase, done: Promise.resolve(phase) };
	const done = plan.run().then((run) => ({
		...phase,
		run,
		asked: askedIn(input.paths, input.node.id, input.session),
	}));
	return { phase, done };
}

/** One-line screen notice describing the agent step, or null. */
export function agentNotice(phase: AgentPhase): string | null {
	if (phase.mode !== "command" || !phase.run) return null;
	if (phase.run.status !== "ok") {
		return `agent unavailable (${phase.run.error}); using roots' own questions`;
	}
	const n = phase.asked;
	return n === 0
		? "the agent had no questions this time"
		: `the agent asked ${n} question${n === 1 ? "" : "s"}`;
}

// ── session end (tier ≥ 2): agent proposals for what changed ──────────────

/**
 * The fixed instruction for the session-end run. Placeholders: {{id}}
 * {{slug}} {{actor}} {{max}}.
 */
export const PROPOSE_INSTRUCTION = `You are helping a human connect one idea in their project to their other ideas.
They just finished a think session on {{id}} ({{slug}}). The lines they changed and the
other ideas in the project are below.

Your only job: when a changed line refers to another idea (by name, paraphrase or
implication, e.g. "this pulls against the auth idea"), propose ONE edge for that pair:

  luuna-roots propose edge {{id}} <other-id> <serves|tension|replaces> --mention \\
    --reason "<why, one line>" --cite '{{id}}:<words copied exactly from the changed line>' \\
    --as {{actor}}

Relations: serves = the first idea is a means to the second; tension = they pull against
each other; replaces = the first supersedes the second. If the OTHER idea serves this one,
swap the two ids (keep the --cite on {{id}}).

Rules:
- Propose at most {{max}} edges. Only for a clear reference; if unsure, propose nothing.
- The cite must be copied exactly from a changed line (an exact substring).
- Never re-propose anything under "Rejected proposals": a human already said no.
- Do not create, edit or delete any file, and never touch .luuna/roots/human/.
- If \`luuna-roots propose\` fails, read its error, then fix the call or move on.
- When you are done, exit. roots ignores anything you print.
`;

/** At most this many agent proposals per session end. */
export const SESSION_PROPOSALS_MAX = 3;

export interface ProposalPhaseInput {
	paths: RootsPaths;
	config: RootsConfig;
	node: NodeRecord;
	session: string;
	changed: readonly ChangedLine[];
	env: Record<string, string | undefined>;
	status?: (text: string) => StatusLine;
	timeoutMs?: number;
}

export interface ProposalPhase {
	actor: Actor;
	run: AgentRunResult;
	/** Proposals the agent filed during the run. */
	filed: string[];
}

function candidateLines(paths: RootsPaths, graph: Graph, self: string): string[] {
	const out: string[] = [];
	for (const t of mentionTargets(paths, graph)) {
		if (t.id !== self) out.push(`- ${t.id} ${t.slug}: "${t.statement}"`);
	}
	return out;
}

export function proposalPrompt(
	packet: ContextPacket,
	changed: readonly ChangedLine[],
	candidates: string[],
	vars: { actor: Actor; max: number },
): string {
	const values: Record<string, string> = {
		id: packet.node.id,
		slug: packet.node.slug,
		actor: vars.actor,
		max: String(vars.max),
	};
	const head = PROPOSE_INSTRUCTION.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
	const lines = [
		"## Changed lines (this session)",
		"",
		...changed.map((l) => `- line ${l.line}: ${l.text}`),
		"",
		"## Other ideas (candidates)",
		"",
		...(candidates.length > 0 ? candidates : ["(none)"]),
		"",
	];
	return `${head}\n---\n\n${lines.join("\n")}\n${renderContextMarkdown(packet)}`;
}

function agentProposalIds(paths: RootsPaths, actor: Actor): Set<string> {
	return new Set(
		readProposals(paths)
			.filter((p) => p.by === actor)
			.map((p) => p.id),
	);
}

/**
 * At session end, tier ≥ 2 with agent.command set and lines changed: ask the
 * agent to propose edges for fuzzy mentions. Returns null when skipped.
 * Never throws for agent failures (same policy as the pre-session step).
 */
export async function runProposalPhase(input: ProposalPhaseInput): Promise<ProposalPhase | null> {
	const { paths, config, node, session } = input;
	const command = config.agent.command;
	if (!command || input.changed.length === 0) return null;
	if (effectiveTier(config, node).tier < 2) return null;
	const graph = readGraph(paths);
	const pending = pendingProposals(readProposals(paths), new Date(), graph).length;
	const max = Math.min(SESSION_PROPOSALS_MAX, config.limits.proposals - pending);
	const candidates = candidateLines(paths, graph, node.id);
	if (max <= 0 || candidates.length === 0) return null;
	const actor = agentActorFor(command);
	const packet = buildContext({ paths, graph, dirs: scanNodeDirs(paths) }, config, node, {
		session,
	});
	const before = agentProposalIds(paths, actor);
	const status = input.status?.(`asking ${actor} to link what changed in ${node.slug}…`);
	const run = await runAgentCommand({
		command,
		cwd: paths.root,
		input: proposalPrompt(packet, input.changed, candidates, { actor, max }),
		env: agentEnv(input.env, { actor, session, node: node.id }),
		timeoutMs: input.timeoutMs ?? config.agent.timeoutSeconds * 1000,
	});
	status?.stop(run.status === "ok" ? undefined : `! agent.command ${run.error}; no agent links`);
	const filed = [...agentProposalIds(paths, actor)].filter((id) => !before.has(id));
	return { actor, run, filed };
}
