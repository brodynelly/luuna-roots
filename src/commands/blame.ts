// luuna-roots blame <id>: idea.md with the question each line answered (src/blame.ts).

import { relative } from "node:path";
import { type Blame, buildBlame } from "../blame.ts";
import { padEnd } from "../color.ts";
import { readEvents } from "../events.ts";
import { formatNodeRef } from "../format.ts";
import type { Output } from "../output.ts";
import { readNodeProse } from "../prose.ts";
import { readQuestions } from "../questions.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { shortTime } from "../time.ts";
import { openWorkspace } from "../workspace.ts";

const GUTTER = 8;

function fileLines(out: Output, b: Blame): string[] {
	const c = out.c;
	let prev: string | null = null;
	return b.lines.map((l) => {
		const label = l.question && l.question !== prev ? l.question : "";
		prev = l.question;
		const mark = l.question ? c.cyan("│") : c.dim("│");
		return `${padEnd(c.id(label), GUTTER)}${mark} ${l.text}`.trimEnd();
	});
}

function answerLines(out: Output, b: Blame): string[] {
	const c = out.c;
	if (b.answers.length === 0) return [c.dim("No answered questions yet. Run `luuna-roots think`.")];
	const lines = [c.bold("Questions answered")];
	for (const a of b.answers) {
		const where =
			a.lines > 0 ? `${a.lines} line${a.lines === 1 ? "" : "s"}` : "no lines left (revised since)";
		lines.push(`${padEnd(c.id(a.question), GUTTER)}${a.text}`);
		lines.push(`${" ".repeat(GUTTER)}${c.dim(`${a.askedBy} · ${shortTime(a.at)} · ${where}`)}`);
	}
	if (b.untracked > 0) {
		const n = b.untracked;
		lines.push(
			c.dim(`${n} answer${n === 1 ? "" : "s"} predate line tracking and cannot be placed`),
		);
	}
	return lines;
}

export const blameCommand: CommandDef = {
	name: "blame",
	group: "read",
	summary: "Show which question each line of an idea answered",
	usage: "blame <id>",
	description:
		"Prints idea.md with the id of the question each line answered in the margin, then\n" +
		"the questions. A think save that answers a question records a hash of each line it\n" +
		"added; blame matches the current lines against them. A line edited later shows no id\n" +
		"(or the id of a later answer that rewrote it). idea.md is never changed.",
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args }) {
		const ws = await openWorkspace(io.cwd);
		const node = resolveNode(ws.graph.nodes, args[0] ?? "", { kind: "idea" });
		const prose = readNodeProse(ws.paths, node, ws.dirs);
		const b = buildBlame(node.id, prose.text, readEvents(ws.paths), readQuestions(ws.paths));
		const path = prose.path ? relative(ws.paths.root, prose.path) : null;
		await out.result({ node: node.id, slug: node.slug, path, ...b });
		await out.lines([
			`${formatNodeRef(out.c, node)}  ${out.c.dim(path ?? "(idea.md missing)")}`,
			"",
			...fileLines(out, b),
			"",
			...answerLines(out, b),
		]);
	},
};
