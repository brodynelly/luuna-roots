// Sprouts: ideas proposed by an agent (`luuna-roots sprout`, tier ≥ 2). They live
// only in .luuna/roots/agent/sprouts/<hex>-<slug>/sprout.md and never become ideas;
// a human may adopt one (adopt.ts: they rewrite it in their own words) or
// reject it.
//
// Lifecycle: open → adopted | rejected | expired.
// Expiry: `expiresAt` is stored on the node when the sprout is filed
// (createdAt + limits.sproutTtlDays), so a later config change does not move
// existing deadlines. Overdue sprouts are expired lazily, like proposals:
// writes (`sprout`, `tend`, `adopt`, `reject`) mark them `expired` with one
// `expire` event each (by `roots`); read commands show them as expired
// without writing (sproutView).
//
// Every agent write is validated (AGENTS.md invariant 4):
//   - the actor is an agent; the project tier (config.yaml) is ≥ 2
//   - statement: one line, non-empty, ≤ SPROUT_STATEMENT_MAX_LENGTH chars
//   - body (--file): ≤ SPROUT_BODY_MAX_BYTES
//   - cap: open sprouts < limits.sprouts
//   - dedup: the statement (case, punctuation and spacing ignored) must not
//     match any idea's statement (composted included: the human retired it)
//     or an open, adopted or rejected sprout. Rejections are permanent.
//     Expired sprouts do not block: nobody looked at them.

import { loadConfig } from "./config.ts";
import { readClaim } from "./endorse.ts";
import { GuardError, UsageError, ValidationError } from "./errors.ts";
import { appendEvent, makeEvent } from "./events.ts";
import { readGraph, updateGraph } from "./graph.ts";
import { createNode } from "./node-create.ts";
import type { RootsPaths } from "./paths.ts";
import { expiresAt } from "./proposals.ts";
import { contentHash } from "./prose.ts";
import { requireTier } from "./tier.ts";
import { isoNow } from "./time.ts";
import type { Actor, Graph, NodeRecord } from "./types.ts";

export const SPROUT_STATEMENT_MAX_LENGTH = 200;
export const SPROUT_BODY_MAX_BYTES = 64 * 1024;

export function isSprout(n: NodeRecord): boolean {
	return n.kind === "sprout";
}

/** Open, but past its expiresAt. */
export function isSproutOverdue(n: NodeRecord, now: Date): boolean {
	return (
		isSprout(n) &&
		n.status === "open" &&
		n.expiresAt !== undefined &&
		Date.parse(n.expiresAt) <= now.getTime()
	);
}

export function isOpenSprout(n: NodeRecord, now: Date): boolean {
	return isSprout(n) && n.status === "open" && !isSproutOverdue(n, now);
}

/** Read-side view: an overdue open sprout shows as `expired` (nothing is written). */
export function sproutView(n: NodeRecord, now: Date): NodeRecord {
	return isSproutOverdue(n, now) ? { ...n, status: "expired" } : n;
}

/** Open sprouts, soonest expiry first. */
export function openSprouts(graph: Graph, now: Date): NodeRecord[] {
	return graph.nodes
		.filter((n) => isOpenSprout(n, now))
		.sort((a, b) => (a.expiresAt ?? "~").localeCompare(b.expiresAt ?? "~"));
}

/** Comparison key for statements: case, punctuation and spacing do not make a sprout new. */
export function statementKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function expireInGraph(graph: Graph, now: Date): NodeRecord[] {
	const out: NodeRecord[] = [];
	for (const n of graph.nodes) {
		if (!isSproutOverdue(n, now)) continue;
		n.status = "expired";
		n.updatedAt = isoNow(now);
		out.push({ ...n });
	}
	return out;
}

async function logExpired(paths: RootsPaths, expired: readonly NodeRecord[]): Promise<void> {
	for (const n of expired) {
		await appendEvent(
			paths,
			makeEvent("expire", "roots", { node: n.id, kind: "sprout", expiresAt: n.expiresAt }),
		);
	}
}

/** Expire overdue sprouts now (one `expire` event each). */
export async function expireSprouts(paths: RootsPaths, now = new Date()): Promise<NodeRecord[]> {
	const expired = await updateGraph(paths, (graph) => {
		const out = expireInGraph(graph, now);
		return { write: out.length > 0, result: out };
	});
	await logExpired(paths, expired);
	return expired;
}

const BLOCKING_SPROUT = new Set(["open", "adopted", "rejected"]);

/** The node whose statement makes `statement` a duplicate, if any. */
export function findStatementDuplicate(
	paths: RootsPaths,
	graph: Graph,
	statement: string,
	now: Date,
): NodeRecord | undefined {
	const key = statementKey(statement);
	return graph.nodes.find((n) => {
		if (isSprout(n) && (!BLOCKING_SPROUT.has(n.status) || isSproutOverdue(n, now))) return false;
		return statementKey(readClaim(paths, graph, n).statement) === key;
	});
}

function duplicateError(n: NodeRecord): ValidationError {
	const why =
		n.kind === "idea"
			? `the human already has this idea (${n.id} ${n.slug})`
			: n.status === "rejected"
				? `the human rejected it (${n.id}${n.decisionReason ? `: "${n.decisionReason}"` : ""}); rejections are permanent`
				: `it is already sprout ${n.id} (${n.status})`;
	return new ValidationError(`duplicate sprout: ${why}`, { duplicate: n.id });
}

/** Clean + check a sprout statement. */
export function checkSproutStatement(raw: string): string {
	if (/[\r\n]/.test(raw.trim())) {
		throw new ValidationError("a sprout statement is one line; put the rest in --file");
	}
	const text = raw.replace(/\s+/g, " ").trim();
	if (text === "") throw new UsageError("the sprout statement is empty");
	if (text.length > SPROUT_STATEMENT_MAX_LENGTH) {
		throw new ValidationError(
			`statement is ${text.length} characters; the limit is ${SPROUT_STATEMENT_MAX_LENGTH}. One claim, one sentence`,
		);
	}
	return text;
}

function checkBody(body: string | undefined): string {
	const text = (body ?? "").trim();
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > SPROUT_BODY_MAX_BYTES) {
		throw new ValidationError(
			`sprout body is ${bytes} bytes; the limit is ${SPROUT_BODY_MAX_BYTES}. Attach long material with \`luuna-roots note\``,
		);
	}
	return text;
}

export function sproutText(statement: string, body: string): string {
	return body === "" ? `${statement}\n` : `${statement}\n\n${body}\n`;
}

export interface SproutInput {
	statement: string;
	/** Optional prose after the statement (from --file). */
	body?: string;
	slug?: string;
	by: Actor;
	now?: Date;
}

export interface SproutResult {
	node: NodeRecord;
	/** Absolute path of sprout.md. */
	file: string;
	statement: string;
	/** Sprouts expired on the way (logged). */
	expired: NodeRecord[];
}

function checkCap(graph: Graph, cap: number, now: Date): void {
	const open = openSprouts(graph, now).length;
	if (open < cap) return;
	throw new ValidationError(
		`${open} sprout${open === 1 ? " is" : "s are"} open (limit ${cap}, limits.sprouts); ` +
			"wait for the human to adopt or reject them in `luuna-roots tend`",
		{ open, cap },
	);
}

/** Validate and file one sprout. Throws on the first failed check. */
export async function fileSprout(paths: RootsPaths, input: SproutInput): Promise<SproutResult> {
	if (!input.by.startsWith("agent:")) throw new GuardError("only agents file sprouts");
	const now = input.now ?? new Date();
	const config = loadConfig(paths);
	requireTier(config, 2, "`luuna-roots sprout`");
	const statement = checkSproutStatement(input.statement);
	const body = checkBody(input.body);
	const dupFirst = findStatementDuplicate(paths, readGraph(paths), statement, now);
	if (dupFirst) throw duplicateError(dupFirst);
	const out = await updateGraph(paths, (graph) => {
		const expired = expireInGraph(graph, now);
		const dup = findStatementDuplicate(paths, graph, statement, now);
		if (dup) throw duplicateError(dup);
		checkCap(graph, config.limits.sprouts, now);
		const created = createNode(paths, graph, {
			kind: "sprout",
			text: sproutText(statement, body),
			statement,
			slug: input.slug,
			by: input.by,
			status: "open",
			now,
			extra: { expiresAt: expiresAt(now, config.limits.sproutTtlDays) },
		});
		return { write: true, result: { ...created, statement, expired } };
	});
	await logExpired(paths, out.expired);
	await appendEvent(
		paths,
		makeEvent("sprout", input.by, {
			node: out.node.id,
			slug: out.node.slug,
			hash: contentHash(sproutText(statement, body)),
			expiresAt: out.node.expiresAt,
		}),
	);
	return out;
}
