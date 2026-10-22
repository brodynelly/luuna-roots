// luuna-roots queue: what needs attention — ideas to think about, open questions,
// pending proposals. Read-only (nothing is expired or asked here).

import { collectAttention, type IdeaAttention, rankAttention } from "../attention.ts";
import { loadConfig } from "../config.ts";
import { formatStatus } from "../format.ts";
import { findNode } from "../graph.ts";
import type { Output } from "../output.ts";
import { pendingProposals, readProposals } from "../proposals.ts";
import { isDue, readQuestions } from "../questions.ts";
import type { CommandDef } from "../registry.ts";
import { type ReadyToBuild, readSeedsIssues, readyToMarkBuilt } from "../seeds-link.ts";
import { openSprouts } from "../sprouts.ts";
import { daysLeft, EXPIRING_SOON_DAYS } from "../tend.ts";
import { questionSource } from "../think-session.ts";
import type { Graph, NodeRecord, ProposalRecord, QuestionRecord } from "../types.ts";
import { openWorkspace } from "../workspace.ts";

function slugOf(graph: Graph, id: string | undefined): string {
	return id ? (findNode(graph, id)?.slug ?? "?") : "?";
}

function thinkLines(out: Output, ranked: IdeaAttention[]): string[] {
	if (ranked.length === 0) return [];
	const c = out.c;
	const lines = [c.bold("Think next") + c.dim("  (luuna-roots think)")];
	for (const a of ranked) {
		const parts = [
			a.due.length ? `${a.due.length} open` : "",
			a.candidates.length ? `${a.candidates.length} new` : "",
		].filter(Boolean);
		lines.push(
			`  ${c.id(a.node.id)} ${a.node.slug}  ${formatStatus(c, a.node.status)}  ${c.dim(parts.join(" · "))}`,
		);
	}
	return lines;
}

function questionLines(out: Output, graph: Graph, qs: QuestionRecord[]): string[] {
	if (qs.length === 0) return [];
	const c = out.c;
	const lines = [c.bold(`Open questions (${qs.length})`)];
	let last = "";
	for (const q of qs) {
		if (q.node !== last) lines.push(`  ${c.id(q.node)} ${slugOf(graph, q.node)}`);
		last = q.node;
		lines.push(`    ? ${c.id(q.id)} ${q.text}  ${c.dim(`[${questionSource(q)}]`)}`);
	}
	return lines;
}

function proposalLine(out: Output, graph: Graph, p: ProposalRecord, now: Date): string {
	const c = out.c;
	const what =
		p.kind === "edge"
			? `${slugOf(graph, p.from)} ─${p.rel ?? "?"}─ ${slugOf(graph, p.to)}`
			: `${p.kind} ${slugOf(graph, p.from)}${p.to ? ` + ${slugOf(graph, p.to)}` : ""}`;
	const days = daysLeft(p.expiresAt ?? null, now);
	const expiry = days === null ? "" : `expires in ${days}d`;
	const soon = days !== null && days <= EXPIRING_SOON_DAYS;
	return `  ${c.id(p.id)} ${what}  ${c.dim(`${p.by},`)} ${soon ? c.yellow(expiry) : c.dim(expiry)}`;
}

function proposalLines(out: Output, graph: Graph, ps: ProposalRecord[], now: Date): string[] {
	if (ps.length === 0) return [];
	const c = out.c;
	const soon = ps.filter((p) => isExpiringSoon(p, now)).length;
	const title = `Pending proposals (${ps.length}${soon ? `, ${soon} expiring soon` : ""})`;
	return [
		c.bold(title) + c.dim("  (luuna-roots tend)"),
		...ps.map((p) => proposalLine(out, graph, p, now)),
	];
}

function isExpiringSoon(p: ProposalRecord, now: Date): boolean {
	return isSoon(p.expiresAt, now);
}

function sproutLines(out: Output, sprouts: NodeRecord[], now: Date): string[] {
	if (sprouts.length === 0) return [];
	const c = out.c;
	const soon = sprouts.filter((n) => isSoon(n.expiresAt, now)).length;
	const title = `Open sprouts (${sprouts.length}${soon ? `, ${soon} expiring soon` : ""})`;
	const lines = [c.bold(title) + c.dim("  (luuna-roots tend · luuna-roots adopt <id>)")];
	for (const n of sprouts) {
		const days = daysLeft(n.expiresAt ?? null, now);
		const expiry = days === null ? "" : `expires in ${days}d`;
		const e = isSoon(n.expiresAt, now) ? c.yellow(expiry) : c.dim(expiry);
		lines.push(`  ${c.dim("[agent]")} ${c.id(n.id)} ${n.slug}  ${c.dim(`${n.author},`)} ${e}`);
	}
	return lines;
}

function builtLines(out: Output, ready: ReadyToBuild[]): string[] {
	if (ready.length === 0) return [];
	const c = out.c;
	const lines = [
		c.bold(`Ready to mark built (${ready.length})`) + c.dim("  (all linked seeds issues closed)"),
	];
	for (const r of ready) {
		const n = r.issues.length;
		lines.push(
			`  ${c.id(r.node.id)} ${r.node.slug}  ${c.dim(`${n} issue${n === 1 ? "" : "s"} closed ·`)} luuna-roots status ${r.node.id} built`,
		);
	}
	return lines;
}

function isSoon(expiresAt: string | undefined, now: Date): boolean {
	const days = daysLeft(expiresAt ?? null, now);
	return days !== null && days <= EXPIRING_SOON_DAYS;
}

export const queueCommand: CommandDef = {
	name: "queue",
	group: "read",
	summary: "What needs attention: open questions, pending proposals, sprouts",
	usage: "queue",
	description:
		"Think next: ideas with open questions or questions the rules would ask, in the\n" +
		"order `luuna-roots think` picks them. Then open questions, pending proposals and open\n" +
		"sprouts (soonest expiry first). With seeds in the repo, committed ideas whose linked\n" +
		'issues are all closed come first under "Ready to mark built" (roots never changes\n' +
		"status itself).",
	maxArgs: 0,
	async run({ io, out }) {
		const ws = await openWorkspace(io.cwd);
		const now = new Date();
		const config = loadConfig(ws.paths);
		const ranked = rankAttention(collectAttention(ws.paths, ws.graph, ws.dirs, config, now));
		const questions = readQuestions(ws.paths)
			.filter((q) => isDue(q, now))
			.sort((a, b) => a.node.localeCompare(b.node) || a.createdAt.localeCompare(b.createdAt));
		const proposals = pendingProposals(readProposals(ws.paths), now, ws.graph).sort((a, b) =>
			(a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""),
		);
		const sprouts = openSprouts(ws.graph, now);
		const ready = readyToMarkBuilt(ws.graph, readSeedsIssues(ws.paths.root));
		await out.result({
			think: ranked.map((a) => ({
				id: a.node.id,
				slug: a.node.slug,
				status: a.node.status,
				open: a.due.map((q) => q.id),
				candidates: a.candidates.map((x) => x.rule),
			})),
			questions,
			proposals,
			sprouts,
			built: ready.map((r) => ({
				id: r.node.id,
				slug: r.node.slug,
				issues: r.issues.map((i) => i.id),
				command: `luuna-roots status ${r.node.id} built`,
			})),
			expiring: [
				...proposals.filter((p) => isExpiringSoon(p, now)).map((p) => p.id),
				...sprouts.filter((n) => isSoon(n.expiresAt, now)).map((n) => n.id),
			],
		});
		const sections = [
			builtLines(out, ready),
			thinkLines(out, ranked),
			questionLines(out, ws.graph, questions),
			proposalLines(out, ws.graph, proposals, now),
			sproutLines(out, sprouts, now),
		].filter((s) => s.length > 0);
		if (sections.length === 0) return out.line("Nothing needs attention.");
		await out.lines(sections.flatMap((s, i) => (i === 0 ? s : ["", ...s])));
	},
};
