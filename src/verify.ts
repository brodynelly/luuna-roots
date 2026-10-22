// `luuna-roots verify`: check the human/agent boundary and graph invariants.
// Read-only: never writes, never runs the directory fix-up.
//
// Every finding is a VerifyIssue with a stable `code` and a severity. Errors
// make `luuna-roots verify` exit non-zero; warnings are reported separately.
//
//   jsonl.parse        a line in a .luuna/roots/*.jsonl file is not a JSON object
//   record.invalid     a graph record lacks required fields / has bad values
//   author.idea        an idea's author is not human:*
//   author.sprout      a sprout's author is not agent:*
//   author.edge        an edge's `by` is not human:*
//   author.proposal    a proposal's `by` is not agent:* or roots[:*]
//   event.no-by        an event has no `by`
//   graph.invariant    an edge breaks an invariant (graph-rules.ts)
//   ref.dangling       an edge/question/proposal points at a missing node
//   dir.missing        a node has no directory or prose file
//   dir.duplicate (w)  several directories share a node's hex
//   dir.orphan (w)     a sprout/notes directory with no matching node
//   boundary.stray     a file under human/ that is not idea.md or assets/ of an idea
//   boundary.hidden (w) a dotfile under human/ (editor swap files, .DS_Store)
//   boundary.symlink   a symlink under human/ that leaves human/ (or dangles)
//   ledger.untrusted-edit  idea.md differs from its last trusted hash and the
//                      change is not committed
//   ledger.agent-commit    ... and the last commit touching it is an agent's
//   ledger.unverifiable (w) ... and git is unavailable to tell
//   ledger.missing (w) an idea has no trusted hash at all
//   seeds.open-on-built (w) a `built` idea still has linked seeds issues open
//
// Trusted hashes come only from `plant` and `session.end` events by a
// human:* actor (adopt records its hash on its `plant` event). A `scan`
// event's scannedHash is never trusted: scanning must not launder an edit.
//
// Extension point: VERIFY_CHECKS is the ordered list of checks. A later stage
// adds a check by appending a function (ctx) => VerifyIssue[].

import { relative } from "node:path";
import { parseActor } from "./actor.ts";
import type { GitProbe } from "./git-trust.ts";
import { graphFromRecords } from "./graph.ts";
import { graphViolations } from "./graph-rules.ts";
import type { RootsPaths } from "./paths.ts";
import { scanNodeDirs } from "./prose.ts";
import { linkedIssues, readSeedsIssues } from "./seeds-link.ts";
import { dedupById } from "./store.ts";
import {
	EDGE_RELS,
	type EventRecord,
	type Graph,
	type GraphRecord,
	isIdeaStatus,
	isNodeKind,
	isSproutStatus,
	type ProposalRecord,
	type QuestionRecord,
} from "./types.ts";
import { boundaryChecks } from "./verify-boundary.ts";
import {
	issue,
	scanJsonl,
	type VerifyCheck,
	type VerifyContext,
	type VerifyIssue,
} from "./verify-core.ts";

export type { Severity, VerifyCheck, VerifyContext, VerifyIssue } from "./verify-core.ts";

// ── Reading ───────────────────────────────────────────────────────────────

function str(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

function nodeProblem(r: Record<string, unknown>): string | null {
	if (!str(r.id) || !str(r.slug) || !str(r.author) || !str(r.createdAt)) {
		return "node needs id, slug, author and createdAt";
	}
	if (!str(r.kind) || !isNodeKind(r.kind))
		return `node ${r.id} has unknown kind "${String(r.kind)}"`;
	const ok = r.kind === "idea" ? isIdeaStatus(String(r.status)) : isSproutStatus(String(r.status));
	return ok ? null : `${r.kind} ${r.id} has invalid status "${String(r.status)}"`;
}

function edgeProblem(r: Record<string, unknown>): string | null {
	if (!str(r.id) || !str(r.from) || !str(r.to) || !str(r.by)) {
		return "edge needs id, from, to and by";
	}
	return (EDGE_RELS as readonly string[]).includes(String(r.rel))
		? null
		: `edge ${r.id} has unknown rel "${String(r.rel)}"`;
}

function graphRecordProblem(r: Record<string, unknown>): string | null {
	if (r.type === "node") return nodeProblem(r);
	if (r.type === "edge") return edgeProblem(r);
	return `unknown record type "${String(r.type)}"`;
}

function readGraphChecked(paths: RootsPaths, issues: VerifyIssue[]): Graph {
	const rel = relative(paths.root, paths.graph);
	const valid: GraphRecord[] = [];
	for (const row of scanJsonl(paths.graph, rel, issues)) {
		const problem = graphRecordProblem(row.value);
		if (problem) {
			issues.push(issue("record.invalid", "error", problem, { file: rel, line: row.line }));
		} else {
			valid.push(row.value as unknown as GraphRecord);
		}
	}
	return graphFromRecords(valid);
}

function readEventsChecked(paths: RootsPaths, issues: VerifyIssue[]): EventRecord[] {
	const rel = relative(paths.root, paths.events);
	const out: EventRecord[] = [];
	for (const row of scanJsonl(paths.events, rel, issues)) {
		if (!str(row.value.by)) {
			issues.push(
				issue("event.no-by", "error", `event "${String(row.value.type)}" has no \`by\``, {
					file: rel,
					line: row.line,
				}),
			);
		}
		out.push(row.value as unknown as EventRecord);
	}
	return out;
}

function readTableChecked<T extends { id: string }>(
	paths: RootsPaths,
	file: string,
	issues: VerifyIssue[],
): T[] {
	const rel = relative(paths.root, file);
	const rows = scanJsonl(file, rel, issues)
		.map((r) => r.value)
		.filter((v): v is Record<string, unknown> & { id: string } => str(v.id));
	return dedupById(rows) as unknown as T[];
}

export function loadVerifyContext(paths: RootsPaths, git: GitProbe): VerifyContext {
	const readIssues: VerifyIssue[] = [];
	return {
		paths,
		graph: readGraphChecked(paths, readIssues),
		dirs: scanNodeDirs(paths),
		events: readEventsChecked(paths, readIssues),
		proposals: readTableChecked<ProposalRecord>(paths, paths.proposals, readIssues),
		questions: readTableChecked<QuestionRecord>(paths, paths.questions, readIssues),
		git,
		readIssues,
	};
}

// ── Checks ────────────────────────────────────────────────────────────────

function actorKind(a: unknown): string | null {
	return typeof a === "string" ? (parseActor(a)?.kind ?? null) : null;
}

function checkAuthors(ctx: VerifyContext): VerifyIssue[] {
	const out: VerifyIssue[] = [];
	for (const n of ctx.graph.nodes) {
		const want = n.kind === "idea" ? "human" : "agent";
		if (actorKind(n.author) !== want) {
			out.push(
				issue(
					`author.${n.kind}`,
					"error",
					`${n.kind} ${n.id} has author "${n.author}"; must be ${want}:*`,
					{
						node: n.id,
					},
				),
			);
		}
	}
	for (const e of ctx.graph.edges) {
		if (actorKind(e.by) !== "human") {
			out.push(
				issue(
					"author.edge",
					"error",
					`edge ${e.id} was made by "${e.by}"; only human:* makes edges`,
					{
						edge: e.id,
					},
				),
			);
		}
	}
	for (const p of ctx.proposals) {
		const k = actorKind(p.by);
		if (k !== "agent" && k !== "roots") {
			out.push(
				issue(
					"author.proposal",
					"error",
					`proposal ${p.id} is by "${String(p.by)}"; must be agent:* or roots`,
					{
						id: p.id,
					},
				),
			);
		}
	}
	return out;
}

function checkGraph(ctx: VerifyContext): VerifyIssue[] {
	return graphViolations(ctx.graph).map((v) =>
		v.message.startsWith("endpoint missing")
			? issue("ref.dangling", "error", `edge ${v.edge}: ${v.message}`, { edge: v.edge })
			: issue("graph.invariant", "error", `edge ${v.edge}: ${v.message}`, { edge: v.edge }),
	);
}

function checkRefs(ctx: VerifyContext): VerifyIssue[] {
	const ids = new Set(ctx.graph.nodes.map((n) => n.id));
	const out: VerifyIssue[] = [];
	const missing = (owner: string, ref: unknown, what: string) => {
		if (typeof ref === "string" && ref !== "" && !ids.has(ref)) {
			out.push(
				issue("ref.dangling", "error", `${owner} ${what} ${ref}, which does not exist`, {
					id: owner,
				}),
			);
		}
	};
	for (const q of ctx.questions) missing(q.id, q.node, "asks about");
	for (const p of ctx.proposals) {
		missing(p.id, p.from, "refers to");
		missing(p.id, p.to, "refers to");
		for (const c of Array.isArray(p.cites) ? p.cites : []) missing(p.id, c?.node, "cites");
	}
	return out;
}

/** Built ideas whose linked seeds issues are not all closed (a warning: humans may know better). */
function checkSeedsBuilt(ctx: VerifyContext): VerifyIssue[] {
	const built = ctx.graph.nodes.filter((n) => n.kind === "idea" && n.status === "built");
	if (built.length === 0) return [];
	const issues = readSeedsIssues(ctx.paths.root);
	const out: VerifyIssue[] = [];
	for (const n of built) {
		const open = linkedIssues(issues, n.id).filter((i) => !i.closed);
		if (open.length === 0) continue;
		const ids = open.map((i) => i.id).join(", ");
		out.push(
			issue(
				"seeds.open-on-built",
				"warning",
				`${n.id} is built but seeds issues are open: ${ids}`,
				{
					node: n.id,
				},
			),
		);
	}
	return out;
}

export const VERIFY_CHECKS: VerifyCheck[] = [
	(ctx) => ctx.readIssues,
	checkAuthors,
	checkGraph,
	checkRefs,
	...boundaryChecks,
	checkSeedsBuilt,
];

export interface VerifyReport {
	issues: VerifyIssue[];
	errors: number;
	warnings: number;
}

export function runVerify(ctx: VerifyContext, checks: readonly VerifyCheck[] = VERIFY_CHECKS) {
	const issues = checks.flatMap((c) => c(ctx));
	const errors = issues.filter((i) => i.severity === "error").length;
	return { issues, errors, warnings: issues.length - errors } satisfies VerifyReport;
}
