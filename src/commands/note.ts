// luuna-roots note <id> --file <path> [--name <n>] --as agent:<model> (agent,
// tier ≥ 1): attach an artifact to a human idea. Copies it into
// .luuna/roots/agent/notes/<hex>/YYYY-MM-DD-<slug>.<ext>. With --question, the
// note is findings on a question the human delegated ([a] in think), and the
// question comes back to the human. See src/notes.ts.

import { resolveAgentActor } from "../actor.ts";
import { flagString } from "../args.ts";
import { UsageError } from "../errors.ts";
import { attachNote, NOTE_MAX_BYTES } from "../notes.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { openWorkspace } from "../workspace.ts";

export const noteCommand: CommandDef = {
	name: "note",
	group: "agent",
	summary: "Attach an artifact to an idea under agent/notes (tier ≥ 1)",
	usage: "note <id> --file <path>",
	description:
		"Copies the file (research, a diagram, HTML, an image) to\n" +
		".luuna/roots/agent/notes/<hex>/YYYY-MM-DD-<name>.<ext>. The human's idea.md is never\n" +
		`touched. Limit: ${NOTE_MAX_BYTES / 1024 / 1024} MiB per file. Refused below tier 1 (per-idea override, else\n` +
		"config). `luuna-roots show` and `luuna-roots context` list an idea's notes.\n" +
		"--question <q-id>: findings on a question the human handed to the agent ([a] in\n" +
		"think). Text only (.md/.txt); its first paragraph is shown under the question when\n" +
		"it comes back to the human, who still answers it in idea.md.",
	flags: {
		file: { type: "string", placeholder: "<path>", description: "The file to attach (required)" },
		name: {
			type: "string",
			placeholder: "<name>",
			description: "Name for the note (default: the file name)",
		},
		question: {
			type: "string",
			placeholder: "<q-id>",
			description: "Findings for this delegated question (reopens it for the human)",
		},
		as: {
			type: "string",
			placeholder: "agent:<model>",
			description: "Agent identity (default: $ROOTS_AGENT)",
		},
	},
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		const by = resolveAgentActor(flagString(flags, "as"), io);
		const file = flagString(flags, "file");
		if (!file) throw new UsageError("--file <path> is required");
		const ws = await openWorkspace(io.cwd);
		const node = resolveNode(ws.graph.nodes, args[0] ?? "", { kind: "idea" });
		const r = await attachNote(ws.paths, {
			node,
			file,
			cwd: io.cwd,
			name: flagString(flags, "name"),
			question: flagString(flags, "question"),
			by,
		});
		await out.result({ id: node.id, note: r.note, question: r.question ?? null });
		const q = r.question ? ` (findings for ${out.c.id(r.question)}, back with the human)` : "";
		await out.success(`noted ${out.c.id(node.id)} ${node.slug}: ${r.note.path}${q}`);
	},
};
