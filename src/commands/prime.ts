// luuna-roots prime [--scope <id>] (agent-facing, read-only): the accepted graph
// as agent context plus how to use roots as an agent. Meant for harness
// SessionStart hooks (`--hook`: silent outside a roots project, so a
// user-level hook costs nothing elsewhere).

import { flagBool, flagString } from "../args.ts";
import { loadConfig } from "../config.ts";
import { findProjectRoot } from "../paths.ts";
import { buildPrime, renderPrimeMarkdown } from "../prime.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { openWorkspace } from "../workspace.ts";

export const primeCommand: CommandDef = {
	name: "prime",
	group: "agent",
	summary: "Accepted graph as agent context (anchors → committed ideas)",
	usage: "prime [--scope <id>]",
	description:
		"Prints anchors (top-level goals) with the ideas that serve them, tensions, the agent\n" +
		"tier and a short command guide. Sprouts, proposals and composted ideas are left out.\n" +
		"--scope limits the tree to one idea, what serves it, and what it serves.",
	flags: {
		scope: { type: "string", placeholder: "<id>", description: "Only this idea's subtree" },
		hook: {
			type: "boolean",
			description: "Harness hook mode: print nothing (exit 0) outside a roots project",
		},
	},
	maxArgs: 0,
	async run({ io, out, flags }) {
		// SessionStart hooks run in every project; stay silent where roots isn't used.
		if (flagBool(flags, "hook") && findProjectRoot(io.cwd) === null) {
			await out.result({ project: null, skipped: "not a roots project" });
			return;
		}
		const ws = await openWorkspace(io.cwd);
		const query = flagString(flags, "scope");
		const scope = query ? resolveNode(ws.graph.nodes, query, { kind: "idea" }) : null;
		const data = buildPrime(ws, loadConfig(ws.paths), scope);
		await out.result({ ...data });
		if (!out.json) await io.stdout(renderPrimeMarkdown(ws, data));
	},
};
