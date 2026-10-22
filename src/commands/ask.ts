// luuna-roots ask <id> <question> --as agent:<model> (agent, tier ≥ 1): queue a
// question about one idea. See src/agent-questions.ts for every check.

import { resolveAgentActor } from "../actor.ts";
import { askAgentQuestion } from "../agent-questions.ts";
import { flagString } from "../args.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { openWorkspace } from "../workspace.ts";

export const askCommand: CommandDef = {
	name: "ask",
	group: "agent",
	summary: "Queue a question about an idea (tier ≥ 1)",
	usage: "ask <id> <question>",
	description:
		"The question shows up in the human's next `luuna-roots think` session on the idea (or the\n" +
		'current one). One line, ending with "?", specific to this idea. Refused when the tier\n' +
		"is below 1, when the idea already has limits.questionsPerSession open agent\n" +
		"questions, or when the same question is open or was dismissed.",
	flags: {
		as: {
			type: "string",
			placeholder: "agent:<model>",
			description: "Agent identity (default: $ROOTS_AGENT)",
		},
		session: {
			type: "string",
			placeholder: "<ss-id>",
			description: "Attach to a running think session (default: $ROOTS_SESSION)",
		},
	},
	minArgs: 2,
	async run({ io, out, args, flags }) {
		const by = resolveAgentActor(flagString(flags, "as"), io);
		const [query = "", ...words] = args;
		const ws = await openWorkspace(io.cwd);
		const node = resolveNode(ws.graph.nodes, query);
		const session = flagString(flags, "session") ?? io.env.ROOTS_SESSION?.trim();
		const { question, session: attached } = await askAgentQuestion(ws.paths, {
			node,
			text: words.join(" "),
			by,
			session: session || undefined,
		});
		await out.result({ id: question.id, node: node.id, question, session: attached });
		await out.success(`asked ${out.c.id(question.id)} on ${out.c.id(node.id)} ${node.slug}`);
	},
};
