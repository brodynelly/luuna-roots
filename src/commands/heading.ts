// luuna-roots heading <text> --cite <id>:<quote> ... (agent, tier ≥ 1): the agent's
// read on where a running `luuna-roots flow` session is going. See src/headings.ts
// for every check.

import { resolveAgentActor } from "../actor.ts";
import { parseCite } from "../agent-proposals.ts";
import { flagList, flagString } from "../args.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { fileHeading } from "../headings.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { openWorkspace } from "../workspace.ts";

export const headingCommand: CommandDef = {
	name: "heading",
	group: "agent",
	summary: "Say where a flow session is going (tier ≥ 1)",
	usage: "heading <text> --cite <id>:<quote> ... [--next <id>]",
	description:
		"Shown in the human's `luuna-roots flow` pane, labeled [agent]; never in views. At most two\n" +
		"sentences and 280 characters. Cite every idea the text names with an exact quote\n" +
		"from its idea.md. --next suggests the idea to think about next. Refused outside a\n" +
		"running flow ($ROOTS_FLOW or --flow) and for text a human dismissed before.",
	flags: {
		cite: {
			type: "string",
			multiple: true,
			placeholder: "<id>:<quote>",
			description: "Exact quote from an idea (repeatable, at least one)",
		},
		next: { type: "string", placeholder: "<id>", description: "Idea to think about next" },
		flow: {
			type: "string",
			placeholder: "<fl-id>",
			description: "The flow session (default: $ROOTS_FLOW)",
		},
		as: {
			type: "string",
			placeholder: "agent:<model>",
			description: "Agent identity (default: $ROOTS_AGENT)",
		},
	},
	minArgs: 1,
	async run({ io, out, args, flags }) {
		const by = resolveAgentActor(flagString(flags, "as"), io);
		const flow = (flagString(flags, "flow") ?? io.env.ROOTS_FLOW ?? "").trim();
		if (flow === "") throw new UsageError("no flow session: pass --flow <fl-id> or set ROOTS_FLOW");
		const ws = await openWorkspace(io.cwd);
		const nextRef = flagString(flags, "next");
		const next = nextRef ? resolveNode(ws.graph.nodes, nextRef, { kind: "idea" }).id : undefined;
		const heading = await fileHeading(ws.paths, loadConfig(ws.paths), {
			flow,
			text: args.join(" "),
			cites: flagList(flags, "cite").map((c) => parseCite(c, ws.graph.nodes)),
			next,
			by,
		});
		await out.result({ id: heading.id, heading });
		await out.success(`heading ${out.c.id(heading.id)} for ${out.c.id(flow)}`);
	},
};
