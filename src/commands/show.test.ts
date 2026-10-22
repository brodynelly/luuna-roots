import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../errors.ts";
import { rootsPaths } from "../paths.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

function addRecords(file: string, records: object[]): void {
	appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

async function fixture() {
	const root = await initProject();
	const a = await plant(root, "Sync works fully offline", ["--slug", "offline-sync"]);
	const b = await plant(root, "The server is always authoritative", [
		"--slug",
		"server-authoritative",
	]);
	const c = await plant(root, "Local first", ["--slug", "local-first"]);
	const paths = rootsPaths(root);
	mkdirSync(join(paths.sprouts, "9f3e-conflict-ui"), { recursive: true });
	writeFileSync(
		join(paths.sprouts, "9f3e-conflict-ui", "sprout.md"),
		"Show a conflict UI\n\nWhy.\n",
	);
	const at = "2026-09-28T12:00:00Z";
	addRecords(paths.graph, [
		{
			type: "node",
			id: "s-9f3e",
			kind: "sprout",
			slug: "conflict-ui",
			status: "open",
			author: "agent:m",
			createdAt: at,
		},
		{
			type: "edge",
			id: "e-0001",
			from: a,
			to: c,
			rel: "serves",
			by: "human:test-human",
			createdAt: at,
		},
		{
			type: "edge",
			id: "e-0002",
			from: a,
			to: b,
			rel: "tension",
			by: "human:test-human",
			proposedBy: "agent:m",
			proposal: "p-0001",
			createdAt: at,
		},
		{
			type: "edge",
			id: "e-0003",
			from: a,
			to: "s-9f3e",
			rel: "derives",
			by: "human:test-human",
			createdAt: at,
		},
	]);
	addRecords(paths.questions, [
		{
			id: "q-0001",
			node: a,
			text: "What would make this done?",
			by: "roots:missing-done",
			status: "open",
			createdAt: at,
		},
		{
			id: "q-0002",
			node: a,
			text: "Deleted records?",
			by: "agent:m",
			status: "answered",
			createdAt: at,
		},
		{ id: "q-0003", node: b, text: "Other", by: "agent:m", status: "open", createdAt: at },
	]);
	addRecords(paths.events, [{ type: "session.end", by: "human:other-person", at, node: a }]);
	return { root, a, b, c, paths };
}

describe("luuna-roots show", () => {
	test("json: node, prose, edges both ways, questions, contributors", async () => {
		const { root, a, c } = await fixture();
		const { exitCode, body } = await runJson<Record<string, unknown>>(["show", "offline"], root);
		expect(exitCode).toBe(0);
		expect(body).toMatchObject({
			success: true,
			command: "show",
			statement: "Sync works fully offline",
			body: "",
			missing: false,
			contributors: ["human:test-human", "human:other-person"],
		});
		const edges = body.edges as {
			direction: string;
			edge: { id: string };
			node: { statement: string };
		}[];
		expect(edges.map((e) => [e.edge.id, e.direction])).toEqual([
			["e-0001", "out"],
			["e-0002", "out"],
			["e-0003", "out"],
		]);
		expect(edges[0]?.node.statement).toBe("Local first");
		expect((body.questions as unknown[]).length).toBe(2);
		const inbound = await runJson<{ edges: { direction: string }[] }>(["show", c], root);
		expect(inbound.body.edges.map((e) => e.direction)).toEqual(["in"]);
		expect(a).toMatch(/^r-/);
	});

	test("human output renders arrows and labels", async () => {
		const { root } = await fixture();
		const out = (await run(["show", "offline-sync"], root)).stdout;
		expect(out).toContain("offline-sync  planted");
		expect(out).toContain('"Sync works fully offline"');
		expect(out).toMatch(/serves\s+→ r-[0-9a-f]{4} local-first/);
		expect(out).toMatch(
			/tension\s+↔ r-[0-9a-f]{4} server-authoritative\s+\(e-0002, proposed by agent:m\)/,
		);
		expect(out).toContain("derives    → [agent] s-9f3e conflict-ui");
		expect(out).toContain("Questions (1 open, 2 total)");
		expect(out).toContain("? q-0001 What would make this done?");
		const other = (await run(["show", "local-first"], root)).stdout;
		expect(other).toMatch(/served by\s+← r-[0-9a-f]{4} offline-sync/);
		const t = (await run(["show", "server"], root)).stdout;
		expect(t).toMatch(/tension\s+↔ r-/);
	});

	test("sprouts show agent prose and label", async () => {
		const { root } = await fixture();
		const r = await run(["show", "9f3e"], root);
		expect(r.stdout).toContain("[agent] s-9f3e  conflict-ui  open");
		expect(r.stdout).toContain("Why.");
		expect(r.stdout).toMatch(/adopted as\s+← r-/);
		expect(r.stdout).toContain(".luuna/roots/agent/sprouts/9f3e-conflict-ui/sprout.md");
	});

	test("missing prose and dangling edges are reported, not fatal", async () => {
		const { root, paths, a } = await fixture();
		rmSync(join(paths.human, `${a.slice(2)}-offline-sync`), { recursive: true });
		addRecords(paths.graph, [
			{
				type: "edge",
				id: "e-0009",
				from: a,
				to: "r-dead",
				rel: "serves",
				by: "human:x",
				createdAt: "2026-09-28T12:00:00Z",
			},
		]);
		const r = await run(["show", a], root);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("(prose file missing)");
		expect(r.stdout).toContain("r-dead (missing)");
		expect((await runJson<{ missing: boolean }>(["show", a], root)).body.missing).toBe(true);
	});

	test("errors: ambiguous, not found, arity", async () => {
		const { root } = await fixture();
		await plant(root, "Offline maps", ["--slug", "offline-maps"]);
		const amb = await runJson<{ code: string; candidates: string[] }>(["show", "offline"], root);
		expect(amb.exitCode).toBe(EXIT.usage);
		expect(amb.body.code).toBe("ambiguous");
		expect(amb.body.candidates).toHaveLength(2);
		expect((await run(["show", "nothing-here"], root)).exitCode).toBe(EXIT.notFound);
		expect((await run(["show"], root)).exitCode).toBe(EXIT.usage);
		expect((await run(["show", "a", "b"], root)).exitCode).toBe(EXIT.usage);
	});
});
