// luuna-roots accept <p-id|s-id> · luuna-roots reject <p-id|s-id> [--reason <t>]
// (human, no TTY; refused inside an agent session). The non-interactive form
// of the decisions `luuna-roots tend` makes. See src/decide.ts.

import { flagString } from "../args.ts";
import { acceptItem, type Decision, rejectItem } from "../decide.ts";
import { hasInteractiveTty, requireHumanCommand } from "../guard.ts";
import { printNext } from "../next.ts";
import type { Output } from "../output.ts";
import type { CommandDef } from "../registry.ts";
import { openWorkspace } from "../workspace.ts";
import { runAdoption } from "./adopt.ts";

/** Human-readable lines describing a decision (shared with tend's summary). */
export function decisionLines(out: Output, d: Decision): string[] {
	const c = out.c;
	const lines: string[] = sproutLines(out, d);
	for (const p of d.proposals) {
		const mark = p.status === "accepted" ? c.green("✓ accepted") : c.yellow("✗ rejected");
		const why = p.decisionReason ? c.dim(` (${p.decisionReason})`) : "";
		lines.push(`${mark} ${c.id(p.id)} ${p.kind}${why}`);
	}
	if (d.edge) {
		const e = d.edge;
		lines.push(`  ${c.green("+")} ${c.id(e.id)} ${e.from} ${e.rel} ${e.to}`);
	}
	for (const s of d.statusChanges) lines.push(`  ${s.node} ${s.from} → ${s.to}`);
	if (d.think) {
		lines.push(
			`  do the split yourself: \`luuna-roots think ${d.think.node}\``,
			c.dim(`  suggested: ${d.think.guidance}`),
		);
	}
	return lines;
}

function sproutLines(out: Output, d: Decision): string[] {
	const s = d.sprout;
	if (!s) return [];
	const c = out.c;
	if (s.idea) {
		return [
			`${c.green("✓ adopted")} ${c.id(s.node.id)} as ${c.id(s.idea.id)} ${s.idea.slug}`,
			...(d.edge
				? [`  ${c.green("+")} ${c.id(d.edge.id)} ${d.edge.from} derives ${d.edge.to}`]
				: []),
			...(s.file ? [`  ${c.dim(s.file)}`] : []),
		];
	}
	const why = s.node.decisionReason ? c.dim(` (${s.node.decisionReason})`) : "";
	return [`${c.yellow(`✗ ${s.node.status}`)} ${c.id(s.node.id)} sprout ${s.node.slug}${why}`];
}

function decisionJson(d: Decision) {
	return {
		id: d.id,
		action: d.action,
		proposals: d.proposals,
		edge: d.edge,
		statusChanges: d.statusChanges,
		think: d.think,
		...(d.sprout ? { sprout: d.sprout.node, idea: d.sprout.idea, path: d.sprout.file } : {}),
	};
}

export const acceptCommand: CommandDef = {
	name: "accept",
	group: "structure",
	summary: "Accept a proposal (s-: adopt a sprout)",
	usage: "accept <p-id|s-id>",
	description:
		"edge: creates the edge. A mention proposal names no relation: pass --rel.\n" +
		"merge: pass --keep <id> (the survivor replaces the other idea, which is composted).\n" +
		"split: marks it accepted; then split the idea yourself in `luuna-roots think <id>`.\n" +
		"compost: composts the idea. Pending edge proposals on the same pair are decided\n" +
		"together (one `tend` card).\n" +
		"sprout (s-): accepting means adopting: same as `luuna-roots adopt <s-id>` (needs a TTY;\n" +
		"you write the idea yourself in $EDITOR).",
	flags: {
		rel: {
			type: "string",
			placeholder: "<serves|tension|replaces>",
			description: "Relation for a mention proposal",
		},
		keep: { type: "string", placeholder: "<id>", description: "merge: the idea that survives" },
		reason: { type: "string", placeholder: "<text>", description: "Optional note" },
	},
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		const by = requireHumanCommand(io, "accept");
		const ws = await openWorkspace(io.cwd);
		const adopt = hasInteractiveTty(io)
			? (id: string) => runAdoption(io, ws.paths, id, { by, split: true })
			: undefined;
		const d = await acceptItem({ paths: ws.paths, by, adopt }, args[0] ?? "", {
			rel: flagString(flags, "rel"),
			keep: flagString(flags, "keep"),
			reason: flagString(flags, "reason"),
		});
		await out.result(decisionJson(d));
		if (!out.quiet) await out.lines(decisionLines(out, d));
		await printNext(out, ws.paths);
	},
};

export const rejectCommand: CommandDef = {
	name: "reject",
	group: "structure",
	summary: "Reject a proposal or sprout; remembered permanently",
	usage: "reject <p-id|s-id> [--reason <t>]",
	description:
		"Agents can never file the same proposal (or sprout statement) again. The reason\n" +
		"goes into their context packet, so say what was wrong.",
	flags: {
		reason: { type: "string", placeholder: "<text>", description: "Why (agents see this)" },
	},
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		const by = requireHumanCommand(io, "reject");
		const ws = await openWorkspace(io.cwd);
		const d = await rejectItem({ paths: ws.paths, by }, args[0] ?? "", flagString(flags, "reason"));
		await out.result(decisionJson(d));
		if (!out.quiet) await out.lines(decisionLines(out, d));
		await printNext(out, ws.paths);
	},
};
