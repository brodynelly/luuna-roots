// The context packet for one idea (roots-e3a2):
// what an agent needs to ask good, specific questions. Read-only. Used by
// `roots context` and by `think` as the stdin of agent.command.
//
// Prior questions include dismissed ones on purpose: they tell the agent what
// the human already refused. Repo state is cheap and failsafe (git branch +
// recent commit subjects; null when git is missing or slow).

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import type { RootsConfig } from "./config.ts";
import { type Endorsed, endorsedMarkdown, readEndorsed } from "./endorse.ts";
import { type EdgeDirection, edgeLabel } from "./format.ts";
import { findNode } from "./graph.ts";
import { learningsFor, type MulchLearning } from "./mulch-link.ts";
import { listNotes, type NoteEntry } from "./notes.ts";
import { readProposals } from "./proposals.ts";
import { readNodeProse } from "./prose.ts";
import { readQuestions } from "./questions.ts";
import { type LinkedIssue, linkedIssues, readSeedsIssues } from "./seeds-link.ts";
import { type EffectiveTier, effectiveTier } from "./tier.ts";
import type {
	Actor,
	EdgeRel,
	NodeRecord,
	ProposalRecord,
	QuestionRecord,
	QuestionStatus,
} from "./types.ts";
import type { Workspace } from "./workspace.ts";

type WsView = Pick<Workspace, "paths" | "graph" | "dirs">;

/** Longest question `roots ask` accepts (characters, after whitespace is collapsed). */
export const QUESTION_MAX_LENGTH = 280;
export const REPO_COMMITS = 5;
const GIT_TIMEOUT_MS = 2000;

export interface ContextNeighbor {
	edge: string;
	rel: EdgeRel;
	direction: EdgeDirection;
	id: string;
	slug: string;
	kind: NodeRecord["kind"] | null;
	status: NodeRecord["status"] | null;
	statement: string;
}

export interface ContextQuestion {
	id: string;
	text: string;
	by: Actor;
	status: QuestionStatus;
	createdAt: string;
	/** Agent findings attached to it (note paths), oldest first. */
	findings: string[];
}

export interface ContextRejection {
	id: string;
	kind: ProposalRecord["kind"];
	from?: string;
	to?: string;
	rel?: EdgeRel | null;
	reason?: string;
	decisionReason?: string;
	by: Actor;
}

export type ContextNote = NoteEntry;

export interface RepoState {
	branch: string | null;
	commits: string[];
}

export interface ContextLimits {
	questionsPerSession: number;
	/** Agent questions on this idea not yet answered or dismissed. */
	agentQuestionsOpen: number;
	/** How many more `roots ask` calls the cap allows right now. */
	asksRemaining: number;
	questionMaxLength: number;
}

export interface ContextPacket {
	project: string;
	node: Pick<NodeRecord, "id" | "kind" | "slug" | "status" | "author" | "createdAt"> & {
		updatedAt: string | null;
	};
	statement: string;
	body: string;
	/** Endorsed ideas: the agent text the human accepted, quoted (roots-6205). */
	endorsed: Endorsed | null;
	/** Prose file relative to the project root (human-owned: agents never edit it). */
	path: string | null;
	tier: EffectiveTier & { config: RootsConfig["tier"] };
	session: string | null;
	neighbors: ContextNeighbor[];
	questions: ContextQuestion[];
	rejectedProposals: ContextRejection[];
	notes: ContextNote[];
	/** Seeds issues linked to this idea (read from .seeds/issues.jsonl). */
	seeds: LinkedIssue[];
	/** Mulch records citing this idea (read from .mulch/expertise/). */
	mulch: MulchLearning[];
	limits: ContextLimits;
	repo: RepoState | null;
}

export interface ContextOptions {
	session?: string | null;
	/** Include git state (default true). */
	repo?: boolean;
}

/** Unresolved agent questions (open or snoozed) on one node. */
export function openAgentQuestions(rows: readonly QuestionRecord[], node: string) {
	return rows.filter(
		(q) =>
			q.node === node &&
			q.by.startsWith("agent:") &&
			(q.status === "open" || q.status === "snoozed"),
	);
}

function neighbors(ws: WsView, node: NodeRecord): ContextNeighbor[] {
	const out: ContextNeighbor[] = [];
	for (const e of ws.graph.edges) {
		if (e.from !== node.id && e.to !== node.id) continue;
		const direction: EdgeDirection = e.from === node.id ? "out" : "in";
		const otherId = direction === "out" ? e.to : e.from;
		const other = findNode(ws.graph, otherId);
		const statement = other ? readNodeProse(ws.paths, other, ws.dirs).statement : "";
		out.push({
			edge: e.id,
			rel: e.rel,
			direction,
			id: otherId,
			slug: other?.slug ?? "?",
			kind: other?.kind ?? null,
			status: other?.status ?? null,
			statement,
		});
	}
	return out;
}

function involves(p: ProposalRecord, id: string): boolean {
	return p.from === id || p.to === id || p.cites.some((c) => c.node === id);
}

function rejections(rows: readonly ProposalRecord[], id: string): ContextRejection[] {
	return rows
		.filter((p) => p.status === "rejected" && involves(p, id))
		.map((p) => ({
			id: p.id,
			kind: p.kind,
			from: p.from,
			to: p.to,
			rel: p.rel,
			reason: p.reason,
			decisionReason: p.decisionReason,
			by: p.by,
		}));
}

function git(cwd: string, args: string[]): string | null {
	try {
		const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
		return r.status === 0 ? r.stdout.trim() : null;
	} catch {
		return null;
	}
}

/** Current branch + recent commit subjects; null outside a git repo. */
export function repoState(cwd: string): RepoState | null {
	if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
	const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
	const log = git(cwd, ["log", `-n${REPO_COMMITS}`, "--format=%h %s"]);
	return { branch: branch || null, commits: log ? log.split("\n").filter(Boolean) : [] };
}

function limitsFor(config: RootsConfig, questions: readonly QuestionRecord[], id: string) {
	const cap = config.limits.questionsPerSession;
	const open = openAgentQuestions(questions, id).length;
	return {
		questionsPerSession: cap,
		agentQuestionsOpen: open,
		asksRemaining: Math.max(0, cap - open),
		questionMaxLength: QUESTION_MAX_LENGTH,
	};
}

export function buildContext(
	ws: WsView,
	config: RootsConfig,
	node: NodeRecord,
	opts: ContextOptions = {},
): ContextPacket {
	const prose = readNodeProse(ws.paths, node, ws.dirs);
	const questions = readQuestions(ws.paths);
	const mine = questions
		.filter((q) => q.node === node.id)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const { id, kind, slug, status, author, createdAt } = node;
	return {
		project: config.project,
		node: { id, kind, slug, status, author, createdAt, updatedAt: node.updatedAt ?? null },
		statement: prose.statement,
		body: prose.body,
		endorsed: readEndorsed(ws.paths, ws.graph, node, ws.dirs),
		path: prose.path ? relative(ws.paths.root, prose.path) : null,
		tier: { ...effectiveTier(config, node), config: config.tier },
		session: opts.session ?? null,
		neighbors: neighbors(ws, node),
		questions: mine.map((q) => ({
			id: q.id,
			text: q.text,
			by: q.by,
			status: q.status,
			createdAt: q.createdAt,
			findings: (q.findings ?? []).map((f) => f.note),
		})),
		rejectedProposals: rejections(readProposals(ws.paths), node.id),
		notes: listNotes(ws.paths, node),
		seeds: linkedIssues(readSeedsIssues(ws.paths.root), node.id),
		mulch: learningsFor(ws.paths.root, node.id),
		limits: limitsFor(config, questions, node.id),
		repo: opts.repo === false ? null : repoState(ws.paths.root),
	};
}

// ── Markdown rendering (the form agent.command receives) ─────────────────

function quote(text: string): string {
	return text
		.split("\n")
		.map((l) => (l === "" ? ">" : `> ${l}`))
		.join("\n");
}

function neighborLine(n: ContextNeighbor): string {
	const { label, arrow } = edgeLabel(n.rel, n.direction);
	const status = n.status ? ` (${n.status})` : "";
	const statement = n.statement ? `: "${n.statement}"` : "";
	return `- ${label} ${arrow} ${n.id} ${n.slug}${status}${statement}`;
}

function questionLine(q: ContextQuestion): string {
	const found = q.findings.length > 0 ? `; findings: ${q.findings.join(", ")}` : "";
	return `- [${q.status}] ${q.text} (${q.id}, ${q.by}${found})`;
}

/** Only when the human handed questions to the agent ([a] in think). */
function delegatedLines(p: ContextPacket): string[] {
	const qs = p.questions.filter((q) => q.status === "delegated");
	if (qs.length === 0) return [];
	return section(
		`Delegated questions (research these; attach findings with \`roots note ${p.node.id} --question <q-id> --file <md>\`)`,
		qs.map((q) => `- ${q.id}: ${q.text}`),
		"",
	);
}

function rejectionLine(r: ContextRejection): string {
	const pair = r.from && r.to ? ` ${r.from} ${r.rel ?? "?"} ${r.to}` : "";
	const why = r.decisionReason ? `; human said: "${r.decisionReason}"` : "";
	return `- ${r.id} ${r.kind}${pair}${r.reason ? ` ("${r.reason}")` : ""}${why}`;
}

function section(title: string, lines: string[], empty: string): string[] {
	return ["", `## ${title}`, "", ...(lines.length > 0 ? lines : [empty])];
}

function headerLines(p: ContextPacket): string[] {
	const t = p.tier;
	const via = t.source === "idea" ? "per-idea override" : "project default";
	const lines = [
		`# roots context: ${p.node.id} ${p.node.slug}`,
		"",
		`- project: ${p.project}`,
		`- status: ${p.node.status} · planted ${p.node.createdAt.slice(0, 10)} by ${p.node.author}`,
		`- agent tier: ${t.tier} (${t.name}, ${via})`,
	];
	if (p.session) lines.push(`- think session: ${p.session}`);
	if (p.path) lines.push(`- file: ${p.path} (human-owned: never edit it)`);
	return lines;
}

function ideaLines(p: ContextPacket): string[] {
	const lines = ["", "## Idea", "", quote(p.statement || "(empty)")];
	if (p.body) lines.push("", p.body);
	if (p.endorsed) {
		lines.push(
			"",
			"The human endorsed this agent text; the idea above is their thoughts on it:",
			"",
			...endorsedMarkdown(p.endorsed, p.node.author),
		);
	}
	return lines;
}

/** Seeds/mulch sections, only when the idea has any (most projects have neither). */
function integrationLines(p: ContextPacket): string[] {
	const lines: string[] = [];
	if (p.seeds.length > 0) {
		lines.push(
			...section(
				"Seeds issues (the work that realizes this idea)",
				p.seeds.map((i) => `- ${i.id} [${i.status}] ${i.title}`),
				"",
			),
		);
	}
	if (p.mulch.length > 0) {
		lines.push(
			...section(
				"Mulch learnings citing this idea",
				p.mulch.map((l) => `- ${l.id ?? "(no id)"} ${l.domain}/${l.type}: ${l.summary}`),
				"",
			),
		);
	}
	return lines;
}

function repoLines(repo: RepoState | null): string[] {
	if (!repo) return [];
	const lines = [`- branch: ${repo.branch ?? "(detached)"}`];
	if (repo.commits.length === 0) lines.push("- (no commits yet)");
	for (const c of repo.commits) lines.push(`- ${c}`);
	return ["", "## Repo", "", ...lines];
}

function limitLines(p: ContextPacket): string[] {
	const l = p.limits;
	return [
		"",
		"## Limits",
		"",
		`- open agent questions on this idea: ${l.agentQuestionsOpen} of ${l.questionsPerSession}`,
		`- asks remaining: ${l.asksRemaining}`,
		`- a question is one line, at most ${l.questionMaxLength} characters, ending with "?"`,
	];
}

/** Compact Markdown packet for an agent to read. */
export function renderContextMarkdown(p: ContextPacket): string {
	const lines = [
		...headerLines(p),
		...ideaLines(p),
		...section("Neighbors", p.neighbors.map(neighborLine), "(none)"),
		...section(
			"Prior questions (never repeat these; dismissed = the human refused it)",
			p.questions.map(questionLine),
			"(none yet)",
		),
		...delegatedLines(p),
		...section(
			"Rejected proposals (do not suggest these again)",
			p.rejectedProposals.map(rejectionLine),
			"(none)",
		),
		...section(
			"Agent notes",
			p.notes.map((n) => `- ${n.path}`),
			"(none)",
		),
		...integrationLines(p),
		...repoLines(p.repo),
		...limitLines(p),
	];
	return `${lines.join("\n")}\n`;
}
