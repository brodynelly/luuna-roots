// roots adopt <sprout-id> (human, TTY): create a new idea from a sprout. The
// human writes it in their own words: $EDITOR opens on an empty idea.md with
// the sprout quoted below a scissors line (removed on save, so any editor or
// terminal shows it), a read-only pager in a split pane under tmux/zellij,
// and a copy printed to stderr. Sprout text is never copied into idea.md.
// Saving nothing above the scissors cancels: no node, no files, no events.
// See src/adopt.ts.

import { relative } from "node:path";
import { completeAdoption, requireOpenSprout } from "../adopt.ts";
import { flagBool, flagString } from "../args.ts";
import type { Decision } from "../decide.ts";
import { referenceBuffer } from "../editor.ts";
import { requireHumanCommand, requireTty } from "../guard.ts";
import type { Io } from "../io.ts";
import { printNext } from "../next.ts";
import type { RootsPaths } from "../paths.ts";
import { readNodeProse } from "../prose.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { launchInSplit, resolvePager, type Spawner, type SplitLaunch } from "../split.ts";
import { sproutDecision } from "../sprout-decide.ts";
import type { Actor, NodeRecord } from "../types.ts";
import { openWorkspace } from "../workspace.ts";
import { composeInEditor } from "./plant.ts";

export interface AdoptionOptions {
	by: Actor;
	/** Try a split pane for the reference (default true). */
	split: boolean;
	slug?: string;
	spawn?: Spawner;
	/**
	 * Endorse instead of rewrite (roots-6205): the human accepts the sprout as
	 * written and the editor holds only their thoughts, prefilled with this text.
	 */
	endorse?: string;
}

function referenceTitle(sprout: NodeRecord): string {
	const who = sprout.author.replace(/^agent:/, "");
	return `[agent] sprout ${sprout.id} ${sprout.slug} (${who}) · reference only`;
}

const REWRITE_HINT = "# Write the idea in your own words ABOVE the line. Nothing above it cancels.";
const ENDORSE_HINT =
	"# Endorsing: the sprout below is kept as the agent's text (quoted, labeled). Write\n" +
	"# your thoughts on it ABOVE the line; they are the human part. Nothing above cancels.";

/** The sprout quoted below the editor's scissors line (stripped on save). */
export function sproutReference(sprout: NodeRecord, text: string, endorse = false): string[] {
	return [
		endorse ? ENDORSE_HINT : REWRITE_HINT,
		"#",
		`# ${referenceTitle(sprout)}`,
		"",
		...text
			.trimEnd()
			.split("\n")
			.map((l) => (l === "" ? ">" : `> ${l}`)),
	];
}

function referenceBlock(
	io: Io,
	sprout: NodeRecord,
	text: string,
	launch: SplitLaunch | null,
	endorse: boolean,
) {
	const lines = [`── ${referenceTitle(sprout)} ──`, ...text.trimEnd().split("\n"), "──"];
	if (launch?.ok) lines.push(`(also open read-only in a ${launch.mux} pane; quit it with q)`);
	lines.push(
		endorse
			? "Endorsing: write your thoughts on the sprout in the editor; the sprout stays the agent's."
			: "Write the idea in your own words in the editor. Do not paste the sprout.",
		"Save an empty file to cancel.",
		"",
	);
	io.stderr(`${lines.join("\n")}\n`);
}

/**
 * The interactive adoption: show the sprout, open $EDITOR on an empty file
 * (or the human's thoughts when endorsing), record the idea + `derives` edge. Throws CancelledError on an empty save.
 * Shared by `roots adopt`, `roots accept s-…` on a TTY and `roots tend`.
 */
export async function runAdoption(
	io: Io,
	paths: RootsPaths,
	sproutId: string,
	opts: AdoptionOptions,
): Promise<Decision> {
	const sprout = await requireOpenSprout(paths, sproutId);
	const prose = readNodeProse(paths, sprout);
	const file = prose.path ? relative(paths.root, prose.path) : "";
	const launch =
		opts.split && file
			? launchInSplit(
					io.env,
					{ command: resolvePager(io.env), file, cwd: paths.root, focus: false },
					opts.spawn,
				)
			: null;
	const reference = prose.text || "(sprout.md missing)";
	const endorse = opts.endorse !== undefined;
	referenceBlock(io, sprout, reference, launch, endorse);
	const buffer = referenceBuffer(sproutReference(sprout, reference, endorse));
	const text = composeInEditor(io, endorse ? `${opts.endorse}${buffer}` : buffer);
	const r = await completeAdoption(paths, {
		sprout: sprout.id,
		text,
		by: opts.by,
		slug: opts.slug,
		endorse,
	});
	const d = sproutDecision(sprout.id, "accept", r.sprout, r.idea, relative(paths.root, r.file));
	d.edge = r.edge;
	return d;
}

export const adoptCommand: CommandDef = {
	name: "adopt",
	group: "capture",
	summary: "Create a new idea from a sprout (rewrite it, or --endorse it with your thoughts)",
	usage: "adopt <sprout-id>",
	description:
		"Opens $EDITOR on an empty idea.md with the sprout quoted below a scissors\n" +
		"line for reference; everything from that line down is removed on save (also\n" +
		"shown in a split pane under tmux/zellij). Write the idea in your own words;\n" +
		"nothing is copied. Saving nothing above the line cancels.\n" +
		"--endorse keeps the sprout as the agent's text (pinned by hash, quoted and\n" +
		"labeled in view/show/prime/context); you write only your thoughts on it.\n" +
		"Records `<new idea> derives <sprout>` and marks the sprout adopted. Needs an\n" +
		"interactive terminal and a human name (ROOTS_USER or git user.name).",
	flags: {
		slug: {
			type: "string",
			placeholder: "<slug>",
			description: "Slug for the new idea (default: from your first line)",
		},
		"no-split": { type: "boolean", description: "Do not open the sprout in a split pane" },
		endorse: {
			type: "boolean",
			description: "Accept the sprout as written; you write only your thoughts on it",
		},
	},
	minArgs: 1,
	maxArgs: 1,
	async run({ io, out, args, flags }) {
		requireTty(io, "adopt");
		const by = requireHumanCommand(io, "adopt");
		const ws = await openWorkspace(io.cwd);
		const sprout = resolveNode(ws.graph.nodes, args[0] ?? "", { kind: "sprout" });
		const d = await runAdoption(io, ws.paths, sprout.id, {
			by,
			split: !flagBool(flags, "no-split"),
			slug: flagString(flags, "slug"),
			endorse: flagBool(flags, "endorse") ? "" : undefined,
		});
		const idea = d.sprout?.idea;
		await out.result({
			id: idea?.id,
			slug: idea?.slug,
			path: d.sprout?.file,
			sprout: d.sprout?.node,
			edge: d.edge,
		});
		const verb = idea?.endorses ? "endorsed" : "adopted";
		await out.success(
			`${verb} ${out.c.id(sprout.id)} as ${out.c.id(idea?.id ?? "")} ${idea?.slug}`,
		);
		await out.info(
			`  ${out.c.dim(`${d.sprout?.file ?? ""} · ${d.edge?.id} derives ${sprout.id}`)}`,
		);
		await printNext(out, ws.paths);
	},
};
