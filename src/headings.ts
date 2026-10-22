// headings.jsonl: the agent's short read on where a `luuna-roots flow` session is
// going (roots-6f2a). Advisory only: shown in the flow pane labeled [agent],
// never in `view`, `prime` or any human file. Every write is validated
// (AGENTS.md invariant 4):
//
//   - the flow is live (flow.start logged, no flow.end)
//   - tier ≥ 1 for the project and for every cited or suggested idea
//   - text: one line, at most HEADING_MAX_LENGTH characters, at most two
//     sentences
//   - at least one citation; each quote is an exact substring of a live
//     idea's prose, and every r- id named in the text is cited
//   - q- ids named in the text exist
//   - `next` (optional) is a live idea
//   - the same text was not dismissed before (a human said no)
//
// The newest active heading of a flow is the one shown. A human dismisses it
// with [x]; dismissed headings go into the next heading run's packet.

import type { RootsConfig } from "./config.ts";
import { GuardError, NotFoundError, ValidationError } from "./errors.ts";
import { appendEvent, makeEvent, readEvents } from "./events.ts";
import { readGraph } from "./graph.ts";
import { citedIdeaIds } from "./idea-refs.ts";
import { generateId, hexSet } from "./ids.ts";
import type { RootsPaths } from "./paths.ts";
import { readNodeProse } from "./prose.ts";
import { readQuestions } from "./questions.ts";
import { appendJsonlFile, readTable, updateTable, withLock } from "./store.ts";
import { requireTier } from "./tier.ts";
import { isoNow } from "./time.ts";
import type { Actor, Citation, Graph, HeadingRecord, NodeRecord } from "./types.ts";

export const HEADING_MAX_LENGTH = 280;
export const HEADING_MAX_SENTENCES = 2;

export function readHeadings(paths: RootsPaths): HeadingRecord[] {
	return readTable<HeadingRecord>(paths.headings);
}

/** The heading to show for `flow`: its newest active one. */
export function activeHeading(headings: readonly HeadingRecord[], flow: string) {
	const mine = headings.filter((h) => h.flow === flow && h.status === "active");
	return mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop() ?? null;
}

/** True when flow.start was logged for `flow` and flow.end was not. */
export function isLiveFlow(paths: RootsPaths, flow: string): boolean {
	let started = false;
	for (const e of readEvents(paths)) {
		if (e.flow !== flow) continue;
		if (e.type === "flow.start") started = true;
		if (e.type === "flow.end") return false;
	}
	return started;
}

export function newFlowId(paths: RootsPaths): string {
	const taken = readEvents(paths)
		.map((e) => e.flow)
		.filter((f): f is string => typeof f === "string");
	return generateId("fl", hexSet(taken));
}

/** Count sentences: runs of text ended by . ! or ? followed by space or the end. */
export function sentenceCount(text: string): number {
	return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "").length;
}

export function cleanHeadingText(raw: string): string {
	const text = raw.replace(/\s+/g, " ").trim();
	if (text === "") throw new ValidationError("the heading is empty");
	if (text.length > HEADING_MAX_LENGTH) {
		throw new ValidationError(
			`the heading is ${text.length} characters; keep it under ${HEADING_MAX_LENGTH}`,
		);
	}
	if (sentenceCount(text) > HEADING_MAX_SENTENCES) {
		throw new ValidationError(`a heading is at most ${HEADING_MAX_SENTENCES} sentences`);
	}
	return text;
}

function liveIdea(graph: Graph, id: string, what: string): NodeRecord {
	const node = graph.nodes.find((n) => n.id === id);
	if (!node) throw new NotFoundError(`${what} ${id} does not exist`);
	if (node.kind !== "idea") throw new ValidationError(`${what} ${id} is a sprout, not an idea`);
	if (node.status === "composted") throw new ValidationError(`${what} ${id} is composted`);
	return node;
}

function checkCites(paths: RootsPaths, graph: Graph, config: RootsConfig, cites: Citation[]) {
	if (cites.length === 0) {
		throw new ValidationError("cite at least one idea: --cite <id>:<exact words>");
	}
	for (const c of cites) {
		const node = liveIdea(graph, c.node, "cited idea");
		requireTier(config, 1, "`luuna-roots heading`", node);
		if (!readNodeProse(paths, node).text.includes(c.quote)) {
			throw new ValidationError(`cite quote not found in ${c.node}`);
		}
	}
}

function checkRefs(paths: RootsPaths, text: string, cites: readonly Citation[]): void {
	const cited = new Set(cites.map((c) => c.node));
	const uncited = citedIdeaIds(text).filter((id) => !cited.has(id));
	if (uncited.length > 0) {
		throw new ValidationError(`the heading names ${uncited.join(", ")}; cite each idea it names`);
	}
	const known = new Set(readQuestions(paths).map((q) => q.id));
	const missing = [...new Set(text.match(/(?<![\w-])q-[0-9a-f]{4,8}(?![\w-])/g) ?? [])].filter(
		(id) => !known.has(id),
	);
	if (missing.length > 0) throw new NotFoundError(`no such question: ${missing.join(", ")}`);
}

export interface HeadingInput {
	flow: string;
	text: string;
	cites: Citation[];
	next?: string;
	by: Actor;
	now?: Date;
}

/** Validate and record a heading (plus its `heading` event). */
export async function fileHeading(
	paths: RootsPaths,
	config: RootsConfig,
	input: HeadingInput,
): Promise<HeadingRecord> {
	requireTier(config, 1, "`luuna-roots heading`");
	if (!isLiveFlow(paths, input.flow)) {
		throw new GuardError(`${input.flow} is not a running flow session`);
	}
	const text = cleanHeadingText(input.text);
	const graph = readGraph(paths);
	checkCites(paths, graph, config, input.cites);
	checkRefs(paths, text, input.cites);
	if (input.next)
		requireTier(config, 1, "`luuna-roots heading --next`", liveIdea(graph, input.next, "--next"));
	const now = input.now ?? new Date();
	const record = await withLock(paths.headings, async () => {
		const all = readHeadings(paths);
		if (all.some((h) => h.status === "dismissed" && h.text === text)) {
			throw new ValidationError("a human dismissed this heading before; say something new");
		}
		const h: HeadingRecord = {
			id: generateId("h", hexSet(all.map((x) => x.id))),
			flow: input.flow,
			text,
			cites: input.cites,
			...(input.next ? { next: input.next } : {}),
			by: input.by,
			status: "active",
			createdAt: isoNow(now),
		};
		await appendJsonlFile(paths.headings, [h]);
		return h;
	});
	const refs = [
		...new Set([...record.cites.map((c) => c.node), ...(record.next ? [record.next] : [])]),
	];
	await appendEvent(
		paths,
		makeEvent("heading", input.by, {
			at: record.createdAt,
			refs,
			heading: record.id,
			flow: record.flow,
		}),
	);
	return record;
}

/** A human hides a heading for good (logged as heading.dismiss). */
export async function dismissHeading(
	paths: RootsPaths,
	id: string,
	by: Actor,
	now = new Date(),
): Promise<HeadingRecord> {
	const at = isoNow(now);
	const h = await updateTable<HeadingRecord, HeadingRecord>(paths.headings, (rows) => {
		const row = rows.find((r) => r.id === id);
		if (!row) throw new NotFoundError(`no heading ${id}`);
		row.status = "dismissed";
		row.dismissedBy = by;
		row.dismissedAt = at;
		return { rows, write: true, result: { ...row } };
	});
	await appendEvent(paths, makeEvent("heading.dismiss", by, { at, heading: id, flow: h.flow }));
	return h;
}

/** Dismissed heading texts (newest last), for the next heading run. */
export function dismissedHeadings(headings: readonly HeadingRecord[]): string[] {
	return headings.filter((h) => h.status === "dismissed").map((h) => h.text);
}
