// luuna-roots view [--from <id>] [--sprouts] [--html] [--out <file>] (read, anyone):
// the compiled culmination. Markdown (or --html) to stdout, or to --out.
//
// With `view.write: true` in config.yaml, every run also refreshes ROOTS.md at
// the repo root with the canonical view (no --from, no --sprouts, Markdown),
// whatever flags were passed, so ROOTS.md always means the same thing. It is
// rewritten only when its content changes. --out never writes under
// .luuna/roots/human/.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flagBool, flagString } from "../args.ts";
import { isHumanPath } from "../boundary.ts";
import { loadConfig } from "../config.ts";
import { GuardError, UsageError } from "../errors.ts";
import { eventsFor, readEvents } from "../events.ts";
import { readQuestions } from "../questions.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { atomicWrite } from "../store.ts";
import { buildView, renderViewMarkdown, type ViewData } from "../view.ts";
import { renderViewHtml } from "../view-html.ts";
import { openWorkspace, type Workspace } from "../workspace.ts";

export const ROOTS_MD = "ROOTS.md";

function resolveFrom(ws: Workspace, query: string | undefined) {
	if (query === undefined) return null;
	const node = resolveNode(ws.graph.nodes, query, { kind: "idea" });
	if (node.status === "composted") {
		throw new UsageError(
			`${node.id} ${node.slug} is composted; the view leaves composted ideas out`,
		);
	}
	return node;
}

/** Write ROOTS.md when its content changed. Returns true when written. */
async function writeRootsMd(ws: Workspace, markdown: string): Promise<boolean> {
	const file = join(ws.paths.root, ROOTS_MD);
	if (existsSync(file) && readFileSync(file, "utf8") === markdown) return false;
	await atomicWrite(file, markdown);
	return true;
}

function render(ws: Workspace, data: ViewData, html: boolean): string {
	if (!html) return renderViewMarkdown(data);
	const events = readEvents(ws.paths);
	return renderViewHtml(data, (id) =>
		[...eventsFor(events, id)].sort((a, b) => String(a.at).localeCompare(String(b.at))),
	);
}

export const viewCommand: CommandDef = {
	name: "view",
	group: "read",
	summary: "Compiled culmination: anchors, what serves them, tensions, questions",
	usage: "view [--from <id>] [--sprouts] [--html] [--out <file>]",
	description:
		"Anchors (committed/shaping ideas that serve nothing) with the ideas that serve them,\n" +
		"depth-first; an idea serving several anchors is printed once, then referenced. Then\n" +
		"tensions and open questions. Composted ideas and sprouts are left out; planted ideas\n" +
		"not under an anchor are listed in one line each. Only human prose and human-accepted\n" +
		"structure. --sprouts adds a separate [agent] section. With view.write: true in\n" +
		"config.yaml, ROOTS.md at the repo root is refreshed with the default view.",
	flags: {
		from: { type: "string", placeholder: "<id>", description: "Start from this idea" },
		sprouts: { type: "boolean", description: 'Append "Agent proposals (not accepted)"' },
		html: { type: "boolean", description: "A static page with a graph and timelines" },
		out: { type: "string", placeholder: "<file>", description: "Write to a file, not stdout" },
	},
	maxArgs: 0,
	async run({ io, out, flags }) {
		const ws = await openWorkspace(io.cwd);
		const config = loadConfig(ws.paths);
		const questions = readQuestions(ws.paths);
		const html = flagBool(flags, "html");
		const target = flagString(flags, "out");
		const outFile = target === undefined ? null : resolve(io.cwd, target);
		if (outFile && isHumanPath(ws.paths, outFile)) {
			throw new GuardError(`refusing to write ${target}: it is inside .luuna/roots/human/`);
		}
		const events = readEvents(ws.paths);
		const data = buildView(ws, config, questions, {
			from: resolveFrom(ws, flagString(flags, "from")),
			sprouts: flagBool(flags, "sprouts"),
			events,
		});
		const text = render(ws, data, html);
		const wrote = config.view.write
			? await writeRootsMd(ws, renderViewMarkdown(buildView(ws, config, questions, { events })))
			: false;
		if (outFile) await atomicWrite(outFile, text);
		await out.result({
			...data,
			format: html ? "html" : "markdown",
			out: outFile,
			rootsMd: config.view.write ? { path: ROOTS_MD, written: wrote } : null,
			...(outFile ? {} : { text }),
		});
		if (out.json) return;
		if (!outFile) await io.stdout(text);
		else await out.success(`wrote ${target}`);
		if (wrote && !out.quiet) io.stderr(`${out.c.green("✓")} updated ${ROOTS_MD}\n`);
	},
};
