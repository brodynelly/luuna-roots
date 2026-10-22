// luuna-roots propose edge|split|merge|compost ... --as agent:<model> (agent,
// tier ≥ 2): file a proposal for the human to review in `luuna-roots tend`. See
// src/agent-proposals.ts for every check.

import { resolveAgentActor } from "../actor.ts";
import { isProposalKind, KIND_NODES, PROPOSAL_KINDS, proposeAsAgent } from "../agent-proposals.ts";
import { flagBool, flagList, flagString } from "../args.ts";
import { UsageError } from "../errors.ts";
import type { CommandDef } from "../registry.ts";
import type { ProposalKind } from "../types.ts";
import { openWorkspace } from "../workspace.ts";

function splitArgs(args: string[]): { kind: ProposalKind; nodes: string[]; rel?: string } {
	const [raw = "", ...rest] = args;
	const kind = raw.toLowerCase();
	if (!isProposalKind(kind)) {
		throw new UsageError(`unknown proposal kind "${raw}"; use ${PROPOSAL_KINDS.join(", ")}`);
	}
	const want = KIND_NODES[kind] + (kind === "edge" ? 1 : 0);
	if (rest.length !== want) {
		const shape: Record<ProposalKind, string> = {
			edge: "edge <a> <b> <serves|tension|replaces>",
			split: "split <id>",
			merge: "merge <a> <b>",
			compost: "compost <id>",
		};
		throw new UsageError(`usage: luuna-roots propose ${shape[kind]} --reason <text> --cite <id>:<quote>`);
	}
	if (kind === "edge") return { kind, nodes: rest.slice(0, 2), rel: rest[2] };
	return { kind, nodes: rest };
}

export const proposeCommand: CommandDef = {
	name: "propose",
	group: "agent",
	summary: "Propose an edge, split, merge or compost (tier ≥ 2)",
	usage: "propose edge|split|merge|compost ...",
	description:
		"  luuna-roots propose edge <a> <b> <serves|tension|replaces> --reason <t> --cite <id>:<quote> ...\n" +
		"  luuna-roots propose split <id> --reason <how it splits> --cite <id>:<quote>\n" +
		"  luuna-roots propose merge <a> <b> --reason <t> --cite <a>:<quote> --cite <b>:<quote>\n" +
		"  luuna-roots propose compost <id> --reason <t> --cite <id>:<quote> ...\n\n" +
		"Every quote must be an exact substring of the cited idea's current idea.md (the\n" +
		"text after the FIRST colon; later colons are part of the quote). Edges and merges\n" +
		"cite both ideas; splits and composts cite the idea. Nothing is linked until a human\n" +
		"accepts it in `luuna-roots tend`. Refused below tier 2, at limits.proposals pending, or when\n" +
		"a human already rejected the same proposal (rejections are permanent).\n" +
		"--mention: cite only the line that mentions the other idea; roots adds its statement.",
	flags: {
		reason: { type: "string", placeholder: "<text>", description: "Why, in one line (required)" },
		cite: {
			type: "string",
			multiple: true,
			placeholder: "<id>:<quote>",
			description: "Exact quote from an idea (repeatable)",
		},
		mention: {
			type: "boolean",
			description: "edge: cite only the mentioning line; roots cites the other idea's statement",
		},
		as: {
			type: "string",
			placeholder: "agent:<model>",
			description: "Agent identity (default: $ROOTS_AGENT)",
		},
	},
	minArgs: 1,
	maxArgs: 4,
	async run({ io, out, args, flags }) {
		const by = resolveAgentActor(flagString(flags, "as"), io);
		const shape = splitArgs(args);
		const ws = await openWorkspace(io.cwd);
		const p = await proposeAsAgent(ws.paths, {
			...shape,
			reason: flagString(flags, "reason"),
			cites: flagList(flags, "cite"),
			mention: flagBool(flags, "mention"),
			by,
		});
		await out.result({ id: p.id, proposal: p });
		const what =
			p.kind === "edge"
				? `${p.from} ${p.rel} ${p.to}`
				: `${p.kind} ${p.from}${p.to ? ` ${p.to}` : ""}`;
		await out.success(`proposed ${out.c.id(p.id)}: ${what} (a human reviews it in \`luuna-roots tend\`)`);
	},
};
