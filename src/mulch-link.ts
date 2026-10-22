// Mulch integration (roots-4689). Read-only: roots reads
// <project>/.luuna/atlas/expertise/<domain>.jsonl directly and never writes to
// .luuna/atlas/.
//
// Record shape (../mulch/src/schemas/record.ts): `type` (convention |
// pattern | failure | decision | reference | guide), optional `id`
// (mx-xxxx), and type-specific text: `content` (convention), `name` +
// `description` (pattern, reference, guide), `description` + `resolution`
// (failure), `title` + `rationale` (decision); plus `evidence`, `tags`,
// `relates_to`, `outcomes`, ...
//
// A record cites an idea when any string anywhere in it (description,
// evidence, relates_to, tags, ...) holds the exact `r-xxxx` token
// (idea-refs.ts). Records are deduped per domain by id, last wins (mulch
// rewrites files, but JSONL merge=union can leave duplicates). Archived
// records (`archived_at`, or anything under .luuna/atlas/archive/) are skipped.

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { citedIdeaIds, shortLine, stringsIn } from "./idea-refs.ts";
import { dedupBy, readJsonlFile } from "./store.ts";

export const MULCH_EXPERTISE_DIR = join(".luuna", "atlas", "expertise");

export interface MulchLearning {
	id: string | null;
	domain: string;
	type: string;
	summary: string;
}

interface MulchRecord extends MulchLearning {
	cites: string[];
}

type Row = Record<string, unknown>;

function text(r: Row, key: string): string {
	const v = r[key];
	return typeof v === "string" ? v : "";
}

function summaryOf(r: Row): string {
	const raw =
		text(r, "name") ||
		text(r, "title") ||
		text(r, "description") ||
		text(r, "content") ||
		text(r, "rationale");
	return shortLine(raw);
}

function domainFiles(root: string): string[] {
	const dir = join(root, MULCH_EXPERTISE_DIR);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

function readDomain(file: string): MulchRecord[] {
	const domain = basename(file, ".jsonl");
	const rows = readJsonlFile<Row>(file).filter((r) => r.archived_at === undefined);
	const deduped = dedupBy(rows, (r) => (typeof r.id === "string" ? r.id : JSON.stringify(r)));
	return deduped.map((r) => ({
		id: typeof r.id === "string" ? r.id : null,
		domain,
		type: text(r, "type") || "?",
		summary: summaryOf(r),
		cites: citedIdeaIds(stringsIn(r).join("\n")),
	}));
}

/** Every live mulch record that cites at least one idea. */
export function readCitingRecords(root: string): MulchRecord[] {
	return domainFiles(root)
		.flatMap(readDomain)
		.filter((r) => r.cites.length > 0);
}

/** Mulch learnings that cite `ideaId`. Pass `records` to reuse one read. */
export function learningsFor(
	root: string,
	ideaId: string,
	records: readonly MulchRecord[] = readCitingRecords(root),
): MulchLearning[] {
	return records
		.filter((r) => r.cites.includes(ideaId))
		.map(({ id, domain, type, summary }) => ({ id, domain, type, summary }));
}
