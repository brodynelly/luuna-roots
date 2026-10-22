// Delegated questions (roots-1a70): the human presses [a]
// in think to hand a question to the agent. After the session, agent.command
// (tier ≥ 1) gets the idea's context packet plus the delegated questions and
// attaches one findings note per question (`luuna-roots note --question`, checked
// in notes.ts), which reopens the question with the finding attached. The
// human sees the finding's first paragraph under the question next time and
// still answers in idea.md: the agent informs, the human decides.
//
// A question the run leaves without findings goes back to the human
// (`undelegate`, by roots). Without agent.command, delegated questions wait
// for a harness (they are listed in `luuna-roots context`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRunResult, agentActorFor, agentEnv, runAgentCommand } from "./agent-runner.ts";
import type { RootsConfig } from "./config.ts";
import { buildContext, renderContextMarkdown } from "./context.ts";
import { readGraph } from "./graph.ts";
import type { RootsPaths } from "./paths.ts";
import { scanNodeDirs } from "./prose.ts";
import { delegatedQuestions, readQuestions, undelegateQuestion } from "./questions.ts";
import type { StatusLine } from "./spinner.ts";
import { effectiveTier } from "./tier.ts";
import type { Actor, NodeRecord, QuestionRecord } from "./types.ts";

/** Placeholders: {{id}} {{slug}} {{actor}}. */
export const DELEGATE_INSTRUCTION = `You are helping a human think about one idea in their project ({{id}}, {{slug}}).
They handed you the questions under "Delegated questions" because they would rather see
research than answer cold. The idea and its context are below.

Your job: for each delegated question, research it (read the repo, its docs, the idea's
neighbors) and attach your findings as one Markdown file, written outside .luuna/roots/:

  luuna-roots note {{id}} --question <q-id> --file <findings.md> --as {{actor}}

Rules:
- Open the file with one plain paragraph of at most three sentences: the answer, as far as
  the facts go. The human sees only that paragraph next to the question. Put details,
  sources and file paths below it.
- Report facts, options and trade-offs. When the question is about intent (what the human
  wants, who should own something), lay out the options and what each implies. Do not
  decide for them.
- If you cannot find an answer, say so in the first paragraph, and say what would settle
  it. Attach the note anyway.
- One note per question. Do not create or edit any other file, and never touch .luuna/roots/human/.
- If \`luuna-roots note\` fails, read its error, then fix the call or move on.
- When you are done, exit. roots ignores anything you print.
`;

export interface DelegationInput {
	paths: RootsPaths;
	config: RootsConfig;
	node: NodeRecord;
	session: string;
	env: Record<string, string | undefined>;
	status?: (text: string) => StatusLine;
	timeoutMs?: number;
	now?: Date;
}

export interface DelegationRun {
	actor: Actor;
	run: AgentRunResult;
	/** Delegated questions sent to the agent. */
	questions: string[];
	/** Questions that came back with findings. */
	found: string[];
	/** Questions returned to the human without findings. */
	returned: string[];
}

function questionBlock(q: QuestionRecord): string[] {
	const prior = (q.findings ?? []).map((f) => `  - earlier findings: ${f.note}`);
	return [`- ${q.id}: ${q.text}`, ...prior];
}

export function delegationPrompt(
	packetMarkdown: string,
	questions: readonly QuestionRecord[],
	vars: { id: string; slug: string; actor: Actor },
): string {
	const values: Record<string, string> = { ...vars };
	const head = DELEGATE_INSTRUCTION.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
	const lines = ["## Delegated questions", "", ...questions.flatMap(questionBlock), ""];
	return `${head}\n---\n\n${lines.join("\n")}\n${packetMarkdown}`;
}

/** Delegated questions on `node` that agent.command can work on now. */
export function delegationPending(
	paths: RootsPaths,
	config: RootsConfig,
	node: NodeRecord,
): QuestionRecord[] {
	if (!config.agent.command || effectiveTier(config, node).tier < 1) return [];
	return delegatedQuestions(readQuestions(paths), node.id);
}

/**
 * Run agent.command on the idea's delegated questions. Null when there is
 * nothing to do (no command, tier 0, nothing delegated). Never throws for
 * agent failures; questions left without findings go back to the human.
 */
export async function runDelegation(input: DelegationInput): Promise<DelegationRun | null> {
	const { paths, config, node, session } = input;
	const command = config.agent.command;
	const pending = delegationPending(paths, config, node);
	if (!command || pending.length === 0) return null;
	const actor = agentActorFor(command);
	const packet = buildContext(
		{ paths, graph: readGraph(paths), dirs: scanNodeDirs(paths) },
		config,
		node,
		{ session },
	);
	const n = pending.length;
	const status = input.status?.(
		`${actor} is researching ${n} question${n === 1 ? "" : "s"} about ${node.slug}…`,
	);
	const run = await runAgentCommand({
		command,
		cwd: paths.root,
		input: delegationPrompt(renderContextMarkdown(packet), pending, {
			id: node.id,
			slug: node.slug,
			actor,
		}),
		env: agentEnv(input.env, { actor, session, node: node.id }),
		timeoutMs: input.timeoutMs ?? config.agent.timeoutSeconds * 1000,
	});
	const reason = run.status === "ok" ? "no findings" : `agent.command ${run.error}`;
	const returned: string[] = [];
	for (const q of pending) {
		if (await undelegateQuestion(paths, q.id, reason, input.now)) returned.push(q.id);
	}
	status?.stop(
		returned.length === 0
			? undefined
			: `! ${returned.length} question(s) came back without findings`,
	);
	const ids = pending.map((q) => q.id);
	return {
		actor,
		run,
		questions: ids,
		found: ids.filter((id) => !returned.includes(id)),
		returned,
	};
}

export interface FindingPreview {
	/** The note's first paragraph (headings skipped), whitespace collapsed. */
	text: string;
	/** The note, relative to the project root. */
	path: string;
	by: Actor;
}

export const PREVIEW_MAX = 400;

/** First prose paragraph of a Markdown/text note: headings, rules and fences skipped. */
export function firstParagraph(text: string): string {
	for (const block of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
		const lines = block
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !/^(#|---|```|<!--)/.test(l));
		if (lines.length > 0) return lines.join(" ").replace(/\s+/g, " ");
	}
	return "";
}

/** The latest finding on a question, for the think screen; null when it has none. */
export function findingPreview(
	paths: RootsPaths,
	q: Pick<QuestionRecord, "findings">,
): FindingPreview | null {
	const f = q.findings?.at(-1);
	if (!f) return null;
	const file = join(paths.root, f.note);
	let text = "(the note is missing)";
	try {
		if (existsSync(file)) text = firstParagraph(readFileSync(file, "utf8")) || "(empty note)";
	} catch {
		text = "(the note could not be read)";
	}
	if (text.length > PREVIEW_MAX) text = `${text.slice(0, PREVIEW_MAX - 1)}…`;
	return { text, path: f.note, by: f.by };
}
