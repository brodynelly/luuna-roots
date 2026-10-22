// The heading run (`luuna-roots flow`, tier ≥ 1, agent.command set, flow.heading
// on): after each think session in a flow, agent.command gets the trail and
// the ideas and calls `luuna-roots heading` once (headings.ts checks every call).
// Runs in the background; a failed or slow agent only means no heading.
// Ideas with a per-idea tier 0 are left out of the packet.

import { type AgentRunResult, agentActorFor, agentEnv, runAgentCommand } from "./agent-runner.ts";
import type { RootsConfig } from "./config.ts";
import { readClaim } from "./endorse.ts";
import type { FlowTrail } from "./flow.ts";
import { readGraph } from "./graph.ts";
import { activeHeading, dismissedHeadings, readHeadings } from "./headings.ts";
import type { RootsPaths } from "./paths.ts";
import { isDue, readQuestions } from "./questions.ts";
import { effectiveTier } from "./tier.ts";
import type { Actor, Graph, HeadingRecord, NodeRecord } from "./types.ts";

/** Placeholders: {{flow}} {{actor}}. */
export const HEADING_INSTRUCTION = `You are watching a human think through their project's ideas in one sitting (flow
session {{flow}}). Below: what they did so far (the trail), the ideas they thought about,
the other ideas, open questions and links.

Your only job: say in at most two sentences where their thinking is converging and the
most important thing still unsaid (a gap, an open question, an unresolved tension).
Say it by running this once:

  luuna-roots heading "<text>" --cite '<id>:<words copied exactly from that idea>' \\
    [--cite ...] [--next <id>] --as {{actor}}

Rules:
- Cite every idea you name (r-xxxx) with words copied exactly from its idea.md. You may
  name open questions by id (q-xxxx).
- --next: the one idea to think about next to close that gap. Leave it out if none fits.
- Describe the human's own thinking. Never add intent, plans or features of your own.
  No praise, and no recap of what they did (they can see the trail).
- Never repeat or rephrase anything under "Dismissed headings": the human rejected those.
- Do not create, edit or delete any file, and never touch .luuna/roots/human/.
- If \`luuna-roots heading\` fails, read its error, then fix the call. Succeed at most once.
- When you are done, exit. roots ignores anything you print.
`;

export function headingEnabled(config: RootsConfig): boolean {
	return config.flow.heading && config.tier >= 1 && config.agent.command !== null;
}

function visible(config: RootsConfig, n: NodeRecord): boolean {
	return n.kind === "idea" && n.status !== "composted" && effectiveTier(config, n).tier >= 1;
}

function trailLines(trail: FlowTrail): string[] {
	const lines = trail.entries.map(
		(e) =>
			`- ${e.id} ${e.slug} (${e.status}): ${e.answered} answered, ${e.open} open` +
			(e.id === trail.current ? "  ← just now" : ""),
	);
	if (trail.planted.length) lines.push(`- planted: ${trail.planted.join(", ")}`);
	if (trail.adopted.length) lines.push(`- adopted from sprouts: ${trail.adopted.join(", ")}`);
	if (trail.accepted) lines.push(`- accepted ${trail.accepted} proposal(s)`);
	return lines.length > 0 ? lines : ["(nothing yet)"];
}

function ideaBlocks(paths: RootsPaths, graph: Graph, nodes: readonly NodeRecord[]): string[] {
	return nodes.flatMap((n) => [
		`### ${n.id} ${n.slug} (${n.status})`,
		"",
		"```markdown",
		readClaim(paths, graph, n).text.trimEnd(),
		"```",
		"",
	]);
}

function edgeLines(graph: Graph, ids: ReadonlySet<string>): string[] {
	const lines = graph.edges
		.filter((e) => ids.has(e.from) && ids.has(e.to))
		.map((e) => `- ${e.from} ${e.rel} ${e.to}`);
	return lines.length > 0 ? lines : ["(none)"];
}

export function headingPacket(
	paths: RootsPaths,
	config: RootsConfig,
	trail: FlowTrail,
	flow: string,
	now: Date,
): string {
	const graph = readGraph(paths);
	const live = graph.nodes.filter((n) => visible(config, n));
	const ids = new Set(live.map((n) => n.id));
	const touched = new Set(trail.entries.map((e) => e.id));
	const headings = readHeadings(paths);
	const current: HeadingRecord | null = activeHeading(headings, flow);
	const questions = readQuestions(paths).filter((q) => ids.has(q.node) && isDue(q, now));
	const others = live.filter((n) => !touched.has(n.id));
	const dismissed = dismissedHeadings(headings);
	const lines = [
		"## Trail (this flow)",
		"",
		...trailLines(trail),
		"",
		"## Ideas thought about this flow",
		"",
		...ideaBlocks(
			paths,
			graph,
			live.filter((n) => touched.has(n.id)),
		),
		"## Other ideas",
		"",
		...(others.length > 0
			? others.map(
					(n) => `- ${n.id} ${n.slug} (${n.status}): "${readClaim(paths, graph, n).statement}"`,
				)
			: ["(none)"]),
		"",
		"## Open questions",
		"",
		...(questions.length > 0
			? questions.map((q) => `- ${q.id} on ${q.node}: ${q.text}`)
			: ["(none)"]),
		"",
		"## Links (accepted)",
		"",
		...edgeLines(graph, ids),
		"",
		"## Current heading",
		"",
		current ? current.text : "(none)",
		"",
		"## Dismissed headings",
		"",
		...(dismissed.length > 0 ? dismissed.map((t) => `- ${t}`) : ["(none)"]),
		"",
	];
	return lines.join("\n");
}

export interface HeadingRunInput {
	paths: RootsPaths;
	config: RootsConfig;
	flow: string;
	trail: FlowTrail;
	env: Record<string, string | undefined>;
	timeoutMs?: number;
	now?: Date;
}

export interface HeadingRun {
	actor: Actor;
	run: AgentRunResult;
	/** The heading the agent filed during this run, if any. */
	heading: HeadingRecord | null;
}

/** Run agent.command for a heading. Null when disabled or there is nothing to read yet. */
export async function runHeadingPhase(input: HeadingRunInput): Promise<HeadingRun | null> {
	const { paths, config, flow } = input;
	const command = config.agent.command;
	if (!command || !headingEnabled(config) || input.trail.entries.length === 0) return null;
	const actor = agentActorFor(command);
	const now = input.now ?? new Date();
	const head = HEADING_INSTRUCTION.replace(/\{\{(\w+)\}\}/g, (m, k: string) =>
		k === "flow" ? flow : k === "actor" ? actor : m,
	);
	const before = new Set(readHeadings(paths).map((h) => h.id));
	const run = await runAgentCommand({
		command,
		cwd: paths.root,
		input: `${head}\n---\n\n${headingPacket(paths, config, input.trail, flow, now)}`,
		env: agentEnv(input.env, { actor, flow }),
		timeoutMs: input.timeoutMs ?? config.agent.timeoutSeconds * 1000,
	});
	const filed = readHeadings(paths).filter((h) => h.flow === flow && !before.has(h.id));
	return { actor, run, heading: filed.pop() ?? null };
}
