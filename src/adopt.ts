// Adopting a sprout (roots-031e). Adoption never copies text:
// the human writes a new idea in their own words while the sprout is shown
// for reference. This module is the non-interactive core; the editor and
// reference display live in commands/adopt.ts.
//
// completeAdoption() does everything in ONE locked graph write:
//   new idea r-xxxx (author = the human) + idea.md with the human's text,
//   edge `r-xxxx derives s-xxxx` (by = the human; graph-rules allowDerives),
//   sprout status open → adopted (decidedBy/decidedAt).
// If any step fails the graph is not written and the new idea directory is
// removed, so nothing is left behind. An empty text cancels before anything
// is written (CancelledError): no node, no files, no events.
// Events (after the lock): `plant` for the idea (with `sprout`), then `adopt`.
//
// Endorsement (endorse: true, roots-6205): the human accepts the sprout as
// written and adds their thoughts. idea.md still holds only the human's text;
// the idea records `endorses: {sprout, hash}` (sprout.md's hash, pinning the
// exact agent text agreed to) and view/show/prime/context quote that text,
// labeled as the agent's. The slug defaults to the sprout statement's.

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { insertEdge } from "./edges.ts";
import { CancelledError, ConflictError, GuardError, NotFoundError } from "./errors.ts";
import { appendEvent, makeEvent } from "./events.ts";
import { findNode, readGraph, updateGraph } from "./graph.ts";
import { chooseSlug, createNode } from "./node-create.ts";
import type { RootsPaths } from "./paths.ts";
import { contentHash, parseProse, readNodeProse } from "./prose.ts";
import { expireSprouts, isSproutOverdue } from "./sprouts.ts";
import { isoNow } from "./time.ts";
import type { Actor, EdgeRecord, Graph, NodeRecord } from "./types.ts";

function openSproutIn(graph: Graph, id: string, now: Date): NodeRecord {
	const node = findNode(graph, id);
	if (node?.kind !== "sprout") {
		throw new NotFoundError(`no sprout ${id}; \`roots list --kind sprout\` lists them`);
	}
	if (isSproutOverdue(node, now))
		throw new ConflictError(`${id} has expired`, { status: "expired" });
	if (node.status !== "open") {
		const who = node.decidedBy ? ` by ${node.decidedBy}` : "";
		throw new ConflictError(`${id} is already ${node.status}${who}`, { status: node.status });
	}
	return node;
}

/** Expire overdue sprouts, then return sprout `id` if it is open (else throw). */
export async function requireOpenSprout(
	paths: RootsPaths,
	id: string,
	now = new Date(),
): Promise<NodeRecord> {
	await expireSprouts(paths, now);
	return openSproutIn(readGraph(paths), id, now);
}

export interface AdoptInput {
	sprout: string;
	/** What the human saved in $EDITOR. */
	text: string;
	by: Actor;
	slug?: string;
	now?: Date;
	/** Accept the sprout as written; `text` is the human's thoughts on it. */
	endorse?: boolean;
}

export interface AdoptResult {
	idea: NodeRecord;
	sprout: NodeRecord;
	edge: EdgeRecord;
	/** Absolute path of the new idea.md. */
	file: string;
	statement: string;
}

function endorsement(paths: RootsPaths, sprout: NodeRecord) {
	const prose = readNodeProse(paths, sprout);
	if (!prose.exists) throw new NotFoundError(`${sprout.id} has no sprout.md to endorse`);
	return { statement: prose.statement, hash: contentHash(prose.text) };
}

function adoptInGraph(paths: RootsPaths, graph: Graph, input: AdoptInput, statement: string) {
	const now = input.now ?? new Date();
	const sprout = openSproutIn(graph, input.sprout, now);
	const endorsed = input.endorse ? endorsement(paths, sprout) : null;
	const created = createNode(paths, graph, {
		kind: "idea",
		text: input.text,
		statement,
		slug: input.slug ?? (endorsed ? chooseSlug(graph, endorsed.statement, undefined) : undefined),
		by: input.by,
		status: "planted",
		now,
		extra: endorsed ? { endorses: { sprout: sprout.id, hash: endorsed.hash } } : undefined,
	});
	try {
		const { edge } = insertEdge(
			graph,
			{ from: created.node.id, to: sprout.id, rel: "derives", by: input.by },
			{ allowDerives: true, now },
		);
		sprout.status = "adopted";
		sprout.decidedBy = input.by;
		sprout.decidedAt = isoNow(now);
		sprout.updatedAt = sprout.decidedAt;
		const result: AdoptResult = {
			idea: created.node,
			file: created.file,
			sprout: { ...sprout },
			edge,
			statement,
		};
		return result;
	} catch (err) {
		rmSync(dirname(created.file), { recursive: true, force: true });
		throw err;
	}
}

/** Create the idea from the human's text and record the lineage. */
export async function completeAdoption(paths: RootsPaths, input: AdoptInput): Promise<AdoptResult> {
	if (!input.by.startsWith("human:")) throw new GuardError("only a human adopts a sprout");
	const { statement } = parseProse(input.text);
	if (statement === "") {
		throw new CancelledError(`empty idea; ${input.sprout} was not adopted and nothing was written`);
	}
	const r = await updateGraph(paths, (graph) => ({
		write: true,
		result: adoptInGraph(paths, graph, input, statement),
	}));
	await appendEvent(
		paths,
		makeEvent("plant", input.by, {
			node: r.idea.id,
			slug: r.idea.slug,
			hash: contentHash(input.text),
			sprout: r.sprout.id,
		}),
	);
	await appendEvent(
		paths,
		makeEvent("adopt", input.by, {
			node: r.sprout.id,
			refs: [r.idea.id],
			idea: r.idea.id,
			edge: r.edge.id,
			...(r.idea.endorses ? { mode: "endorse", sproutHash: r.idea.endorses.hash } : {}),
		}),
	);
	return r;
}
