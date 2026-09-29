// roots flow [<id>] (human, TTY): think, review and plant in one session.
// See src/flow-session.ts.

import { flagBool } from "../args.ts";
import { colorEnabled, makeColors } from "../color.ts";
import { loadConfig } from "../config.ts";
import { type EditorPane, showInEditorPane } from "../editor-pane.ts";
import { CancelledError, GuardError } from "../errors.ts";
import type { FlowTrail } from "../flow.ts";
import { runFlow } from "../flow-session.ts";
import { requireHumanCommand, requireTty } from "../guard.ts";
import type { Io } from "../io.ts";
import { printNext } from "../next.ts";
import type { Output } from "../output.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { startStatus } from "../spinner.ts";
import { runTend } from "../tend-session.ts";
import type { Actor } from "../types.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";
import { runAdoption } from "./adopt.ts";
import { composeInEditor, plantText } from "./plant.ts";
import { tendLine, thinkRunner } from "./tend.ts";
import { startThink, tallyLine } from "./think.ts";

function steps(io: Io, ws: Workspace, by: Actor, split: boolean) {
	const pane: EditorPane = { id: null };
	const launch = (file: string) => showInEditorPane(io.env, pane, file, ws.paths.root);
	const terminal = io.terminal;
	if (!terminal) throw new GuardError("`roots flow` needs an interactive terminal");
	return {
		think: async (id: string, background: Parameters<typeof startThink>[3]["background"]) => {
			const fresh = await openWorkspace(io.cwd);
			const node = resolveNode(fresh.graph.nodes, id, { kind: "idea" });
			const run = await startThink(io, fresh, node, { by, split, background, launch });
			return run.summary;
		},
		tend: async () => {
			const s = await runTend({
				paths: ws.paths,
				by,
				terminal,
				colors: makeColors(colorEnabled(io.env, true)),
				think: thinkRunner(io, by, split),
				adopt: (id, endorse) => runAdoption(io, ws.paths, id, { by, split, endorse }),
			});
			return tendLine(s);
		},
		plant: async () => {
			io.stderr("Write the idea in your editor: one claim on the first line. Empty cancels.\n");
			try {
				const planted = await plantText(ws.paths, composeInEditor(io), by);
				return planted?.node.id ?? null;
			} catch (err) {
				if (err instanceof CancelledError) return null;
				throw err;
			}
		},
	};
}

function trailLines(out: Output, t: FlowTrail): string[] {
	const lines = t.entries.map(
		(e) =>
			`  ${out.c.id(e.id)} ${e.slug}  ${out.c.dim(`${e.answered} answered · ${e.open} open · ${e.status}`)}`,
	);
	const extra = [
		t.planted.length ? `planted ${t.planted.join(", ")}` : "",
		t.adopted.length ? `adopted ${t.adopted.join(", ")}` : "",
		t.accepted ? `accepted ${t.accepted}` : "",
	].filter(Boolean);
	if (extra.length) lines.push(`  ${out.c.dim(extra.join(" · "))}`);
	return lines;
}

export const flowCommand: CommandDef = {
	name: "flow",
	group: "capture",
	summary: "Think, review and plant in one session; the agent works in the background",
	usage: "flow [<id>]",
	description:
		"Moves from idea to idea without dropping to the shell. Between think sessions a card\n" +
		"shows what this flow did (trail), the agent's heading ([agent], cited, never in views),\n" +
		"agent work still running, the inbox and the next idea. Keys: [enter] the recommended\n" +
		"step (review the inbox, else think the next idea)  [n] think the next idea  [o] other\n" +
		"idea  [p] plant  [x] dismiss the heading  [q] end the flow. Agent questions arrive\n" +
		"while you write; links and the heading are worked out after each session. Under tmux\n" +
		"with vim/nvim one editor pane follows the flow. With an id, starts by thinking it.",
	flags: {
		"no-split": { type: "boolean", description: "Do not open $EDITOR in a split pane" },
	},
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		requireTty(io, "flow");
		const by = requireHumanCommand(io, "flow");
		const terminal = io.terminal;
		if (!terminal) throw new GuardError("`roots flow` needs an interactive terminal");
		const ws = await openWorkspace(io.cwd);
		const start = args[0] ? resolveNode(ws.graph.nodes, args[0], { kind: "idea" }).id : undefined;
		const summary = await runFlow({
			paths: ws.paths,
			config: loadConfig(ws.paths),
			by,
			terminal,
			colors: makeColors(colorEnabled(io.env, true)),
			env: io.env,
			tally: tallyLine,
			start,
			...steps(io, ws, by, !flagBool(flags, "no-split")),
		});
		if (summary.running.length > 0) {
			const status = startStatus(
				io.stderr,
				`waiting for the agent: ${summary.running.join(", ")}…`,
				{
					animate: io.stdoutIsTTY,
					columns: () => terminal.columns(),
				},
			);
			await summary.pending;
			status.stop();
		}
		await out.result({ flow: summary.flow, trail: summary.trail, problems: summary.problems });
		await out.success(`flow ${out.c.id(summary.flow)} ended`);
		await out.lines(trailLines(out, summary.trail));
		for (const p of summary.problems) out.warn(p);
		await printNext(out, ws.paths);
	},
};
