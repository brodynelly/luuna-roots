// luuna-roots context <id> (agent-facing, read-only): the context packet for one
// idea. Markdown for agents to read; --json for tools. Never writes.

import { flagString } from "../args.ts";
import { loadConfig } from "../config.ts";
import { buildContext, renderContextMarkdown } from "../context.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { openWorkspace } from "../workspace.ts";

export const contextCommand: CommandDef = {
	name: "context",
	group: "agent",
	summary: "Context packet for one idea (prose, neighbors, history)",
	usage: "context <id>",
	description:
		"Read-only. Prints the idea's prose, status, neighbors, prior questions (dismissed\n" +
		"ones included, so agents learn what not to ask), rejected proposals, agent notes,\n" +
		"linked Missions issues and Atlas expertise, the effective agent tier and limits, and\n" +
		"recent repo state.",
	flags: {
		session: {
			type: "string",
			placeholder: "<ss-id>",
			description: "Think session the packet is for (default: $ROOTS_SESSION)",
		},
		"no-repo": { type: "boolean", description: "Skip git branch / recent commits" },
	},
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		const ws = await openWorkspace(io.cwd);
		const node = resolveNode(ws.graph.nodes, args[0] ?? "");
		const session = flagString(flags, "session") ?? io.env.ROOTS_SESSION?.trim() ?? null;
		const packet = buildContext(ws, loadConfig(ws.paths), node, {
			session: session || null,
			repo: flags["no-repo"] !== true,
		});
		await out.result({ ...packet });
		if (!out.json) await io.stdout(renderContextMarkdown(packet));
	},
};
