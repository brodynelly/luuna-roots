import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { buildContext, renderContextMarkdown } from "./context.ts";
import { findNode, readGraph, updateGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { scanNodeDirs } from "./prose.ts";
import { addQuestions, dismissQuestion } from "./questions.ts";
import { updateTable } from "./store.ts";
import { initProject, plant } from "./test-helpers.ts";
import type { ProposalRecord } from "./types.ts";

const AT = "2026-09-28T10:00:00.000Z";

async function fixture() {
	const root = await initProject();
	const a = await plant(root, "Sync works offline");
	const b = await plant(root, "The server is always authoritative", ["--slug", "server"]);
	const paths = rootsPaths(root);
	await updateGraph(paths, (g) => {
		g.edges.push({
			type: "edge",
			id: "e-0001",
			from: a,
			to: b,
			rel: "tension",
			by: "human:test-human",
			createdAt: AT,
		});
		return { write: true, result: null };
	});
	const [asked, dismissed] = await addQuestions(paths, [
		{ node: a, text: "What happens to deleted records?", by: "agent:opus" },
		{ node: a, text: "Why now?", by: "agent:opus" },
	]);
	await dismissQuestion(paths, dismissed?.id ?? "", { by: "human:test-human", session: "ss-1" });
	const rejected: ProposalRecord = {
		id: "p-0001",
		kind: "edge",
		from: a,
		to: b,
		rel: "serves",
		reason: "sync serves the server",
		cites: [],
		by: "agent:opus",
		status: "rejected",
		createdAt: AT,
		decisionReason: "no it does not",
	};
	await updateTable<ProposalRecord, null>(paths.proposals, (rows) => ({
		rows: [...rows, rejected],
		write: true,
		result: null,
	}));
	const notes = join(paths.notes, a.slice(2));
	mkdirSync(notes, { recursive: true });
	writeFileSync(join(notes, "prior-art.md"), "# notes\n");
	return { root, paths, a, b, asked };
}

function packetFor(root: string, id: string, opts = {}) {
	const paths = rootsPaths(root);
	const graph = readGraph(paths);
	const node = findNode(graph, id);
	if (!node) throw new Error("no node");
	return buildContext({ paths, graph, dirs: scanNodeDirs(paths) }, loadConfig(paths), node, opts);
}

describe("context packet", () => {
	test("collects prose, neighbors, prior + dismissed questions, rejections, notes, limits", async () => {
		const { root, a, b } = await fixture();
		const p = packetFor(root, a, { session: "ss-9", repo: false });
		expect(p.statement).toBe("Sync works offline");
		expect(p.path).toMatch(/^\.luuna\/roots\/human\/[0-9a-f]{4}-sync-works-offline\/idea\.md$/);
		expect(p.session).toBe("ss-9");
		expect(p.tier).toEqual({ tier: 2, name: "propose", source: "config", config: 2 });
		expect(p.neighbors).toEqual([
			{
				edge: "e-0001",
				rel: "tension",
				direction: "out",
				id: b,
				slug: "server",
				kind: "idea",
				status: "planted",
				statement: "The server is always authoritative",
			},
		]);
		expect(p.questions.map((q) => [q.text, q.status])).toEqual([
			["What happens to deleted records?", "open"],
			["Why now?", "dismissed"],
		]);
		expect(p.rejectedProposals).toMatchObject([{ id: "p-0001", decisionReason: "no it does not" }]);
		expect(p.notes).toMatchObject([
			{ name: "prior-art.md", path: `.luuna/roots/agent/notes/${a.slice(2)}/prior-art.md` },
		]);
		expect(p.limits).toEqual({
			questionsPerSession: 3,
			agentQuestionsOpen: 1,
			asksRemaining: 2,
			questionMaxLength: 280,
		});
		expect(p.repo).toBeNull();
	});

	test("markdown packet is compact and complete", async () => {
		const { root, a } = await fixture();
		const md = renderContextMarkdown(packetFor(root, a, { repo: false }));
		expect(md).toStartWith(`# luuna-roots context: ${a} sync-works-offline\n`);
		expect(md).toContain("> Sync works offline");
		expect(md).toContain("tension ↔ r-");
		expect(md).toContain(': "The server is always authoritative"');
		expect(md).toContain("- [dismissed] Why now?");
		expect(md).toContain('human said: "no it does not"');
		expect(md).toContain("prior-art.md");
		expect(md).toContain("asks remaining: 2");
		expect(md).not.toContain("## Repo");
	});

	test("repo state: branch and recent commits; failsafe outside git", async () => {
		const { root, a } = await fixture();
		expect(packetFor(root, a).repo).toBeNull();
		const git = (...args: string[]) =>
			spawnSync("git", args, {
				cwd: root,
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			});
		git("init", "-q", "-b", "trunk");
		expect(packetFor(root, a).repo).toEqual({ branch: "trunk", commits: [] });
		git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"first",
		);
		const repo = packetFor(root, a).repo;
		expect(repo?.commits).toHaveLength(1);
		expect(repo?.commits[0]).toMatch(/^[0-9a-f]+ first$/);
		expect(renderContextMarkdown(packetFor(root, a))).toContain("- branch: trunk");
	});
});
