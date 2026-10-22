// luuna-roots think [<id>] (human, TTY): one think session on one idea.

import { relative } from "node:path";
import { resolveHumanActor } from "../actor.ts";
import { flagBool } from "../args.ts";
import { collectAttention, rankAttention } from "../attention.ts";
import { colorEnabled, makeColors } from "../color.ts";
import { loadConfig } from "../config.ts";
import { GuardError, UsageError } from "../errors.ts";
import { requireTty } from "../guard.ts";
import type { Io } from "../io.ts";
import { printNext } from "../next.ts";
import type { Output } from "../output.ts";
import { readNodeProse } from "../prose.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { startStatus } from "../spinner.ts";
import { editorHint, launchEditorSplit, type SplitLaunch } from "../split.ts";
import type { ScreenGuidance } from "../think-screen.ts";
import { runThinkSession, type SessionSummary, type ThinkDeps } from "../think-session.ts";
import type { Actor, NodeRecord } from "../types.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";

function pickNode(ws: Workspace, query: string | undefined): NodeRecord | null {
	if (query !== undefined) {
		const node = resolveNode(ws.graph.nodes, query, { kind: "idea" });
		if (node.status === "composted") {
			throw new UsageError(`${node.id} is composted; there is nothing left to think about`);
		}
		return node;
	}
	const config = loadConfig(ws.paths);
	const ranked = rankAttention(collectAttention(ws.paths, ws.graph, ws.dirs, config, new Date()));
	return ranked[0]?.node ?? null;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function tallyLine(s: SessionSummary): string {
	const t = s.tally;
	const parts = [
		t.answered ? `${t.answered} answered` : "",
		t.dismissed ? `${t.dismissed} dismissed` : "",
		t.snoozed ? `${t.snoozed} snoozed` : "",
		t.skipped ? `${t.skipped} skipped` : "",
		t.delegated ? `${t.delegated} handed to the agent` : "",
		t.unasked ? `${t.unasked} left for next time` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "no questions";
}

async function printSummary(
	out: Output,
	ws: Workspace,
	node: NodeRecord,
	s: SessionSummary,
): Promise<void> {
	const c = out.c;
	await out.success(`session ${c.id(s.session)} on ${c.id(node.id)} ${node.slug} ended`);
	await out.info(`  ${tallyLine(s)}${s.changed ? "" : c.dim(" · idea.md unchanged")}`);
	if (s.statusChange) await out.info(`  status ${s.statusChange.from} → ${s.statusChange.to}`);
	const filed = s.mentions?.result.filed ?? [];
	if (filed.length > 0) {
		const slug = (id = "") => ws.graph.nodes.find((n) => n.id === id)?.slug ?? id;
		const refs = filed.map((p) => `${c.id(p.id)} → ${slug(p.to)}`).join(", ");
		await out.info(`  ${plural(filed.length, "mention proposal")} filed: ${refs}`);
	}
	if (s.mentionError) out.warn(`mention scan failed: ${s.mentionError}`);
	const agentFiled = s.proposals?.filed ?? [];
	if (agentFiled.length > 0) {
		await out.info(
			`  ${s.proposals?.actor} proposed ${plural(agentFiled.length, "link")}: ${agentFiled.join(", ")}`,
		);
	}
	if (filed.length + agentFiled.length > 0)
		await out.info(c.dim("  review them with `luuna-roots tend`"));
	const research = delegationLine(s);
	if (research) await out.info(`  ${research}`);
	const line = agentLine(s);
	if (line) await out.info(`  ${line}`);
	if (s.agent.error)
		out.warn(`agent.command ${s.agent.error}; the session used roots' own questions`);
}

function delegationLine(s: SessionSummary): string | null {
	const d = s.delegation;
	if (!d || d.status === "background") return null;
	const parts = [
		d.found.length > 0
			? `${d.actor} researched ${d.found.join(", ")}: findings wait under the question next session`
			: "",
		d.returned.length > 0 ? `${d.returned.join(", ")} came back without findings` : "",
	].filter(Boolean);
	if (d.error) parts.push(`research run: ${d.error}`);
	return parts.length > 0 ? parts.join("; ") : null;
}

function agentLine(s: SessionSummary): string | null {
	const a = s.agent;
	const parts = [
		a.mode === "command" && a.status === "ok"
			? `${a.actor} asked ${plural(a.asked, "question")}`
			: "",
		a.arrived > 0 ? `${plural(a.arrived, "agent question")} arrived during the session` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : null;
}

async function nothingQueued(out: Output): Promise<void> {
	await out.result({ session: null, reason: "nothing-queued" });
	await out.line("Nothing needs thinking right now.");
	await out.info(out.c.dim("Run `luuna-roots think <id>` to think about a specific idea."));
}

export interface ThinkRun {
	summary: SessionSummary;
	file: string;
	launch: SplitLaunch | null;
}

/**
 * Open the editor (split pane when possible) and run one think session on
 * `node`. Shared by `luuna-roots think` and `luuna-roots tend` (accepted splits).
 */
export async function startThink(
	io: Io,
	ws: Workspace,
	node: NodeRecord,
	opts: {
		by: Actor;
		split: boolean;
		guidance?: ScreenGuidance;
		/** Background agent mode (flow); see ThinkDeps.background. */
		background?: ThinkDeps["background"];
		/** Opens the editor instead of a fresh split (flow reuses one pane). */
		launch?: (file: string) => SplitLaunch;
	},
): Promise<ThinkRun> {
	const terminal = io.terminal;
	if (!terminal) throw new GuardError("`luuna-roots think` needs an interactive terminal");
	const prose = readNodeProse(ws.paths, node, ws.dirs);
	const file = prose.path ? relative(ws.paths.root, prose.path) : "";
	const launch = !opts.split
		? null
		: opts.launch
			? opts.launch(file)
			: launchEditorSplit(io.env, file, ws.paths.root);
	const summary = await runThinkSession({
		paths: ws.paths,
		config: loadConfig(ws.paths),
		node,
		by: opts.by,
		terminal,
		colors: makeColors(colorEnabled(io.env, true)),
		editorHint: editorHint(launch, file),
		env: io.env,
		agentStatus: (text) =>
			startStatus(io.stderr, text, { animate: io.stdoutIsTTY, columns: () => terminal.columns() }),
		guidance: opts.guidance,
		background: opts.background,
	});
	return { summary, file, launch };
}

export const thinkCommand: CommandDef = {
	name: "think",
	group: "capture",
	summary: "Run a think session. With no id, picks from the queue",
	usage: "think [<id>]",
	description:
		"Shows one question at a time about the idea. Write in idea.md in your editor:\n" +
		"a save that changes the file answers the current question and moves on.\n" +
		"Keys: [d] dismiss (never ask again)  [z] snooze  [s] skip  [q] end session.\n" +
		"[a] ask agent (tier ≥ 1): after the session agent.command researches the question\n" +
		"and attaches findings; it comes back with them, and you still answer in idea.md.\n" +
		"Inside tmux or zellij, $EDITOR opens in a split pane; otherwise open the\n" +
		"printed path in another pane. With no id, think picks the idea most in need:\n" +
		"ideas with open questions first, then the most pending questions, planted before\n" +
		"shaping before committed, least recently touched first (see `luuna-roots queue`).",
	flags: {
		"no-split": { type: "boolean", description: "Do not open $EDITOR in a split pane" },
	},
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		requireTty(io, "think");
		const by = resolveHumanActor(io);
		const ws = await openWorkspace(io.cwd);
		const node = pickNode(ws, args[0]);
		if (!node) return nothingQueued(out);
		const run = await startThink(io, ws, node, { by, split: !flagBool(flags, "no-split") });
		await out.result({ ...run.summary, slug: node.slug, path: run.file, split: run.launch });
		await printSummary(out, ws, node, run.summary);
		await printNext(out, ws.paths, { exclude: node.id });
	},
};
