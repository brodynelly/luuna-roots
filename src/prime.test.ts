import { describe, expect, test } from "bun:test";
import { updateGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { initProject, plant, run, runJson } from "./test-helpers.ts";
import type { EdgeRel } from "./types.ts";

async function link(root: string, from: string, to: string, rel: EdgeRel, id: string) {
	await updateGraph(rootsPaths(root), (g) => {
		g.edges.push({ type: "edge", id, from, to, rel, by: "human:t", createdAt: "2026-01-01" });
		return { write: true, result: null };
	});
}

async function fixture() {
	const root = await initProject();
	const goal = await plant(root, "Field users never lose work", ["--slug", "goal"]);
	const sync = await plant(root, "Sync works offline");
	const queue = await plant(root, "Writes go to a local queue first", ["--slug", "queue"]);
	const auth = await plant(root, "The server is always authoritative");
	const gone = await plant(root, "Old idea");
	await link(root, sync, goal, "serves", "e-0001");
	await link(root, queue, sync, "serves", "e-0002");
	await link(root, sync, auth, "tension", "e-0003");
	await updateGraph(rootsPaths(root), (g) => {
		const n = g.nodes.find((x) => x.id === gone);
		if (n) n.status = "composted";
		const q = g.nodes.find((x) => x.id === queue);
		if (q) q.tier = 0;
		return { write: true, result: null };
	});
	return { root, goal, sync, queue, auth, gone };
}

describe("luuna-roots prime", () => {
	test("anchors with serving ideas nested; tensions; overrides; composted left out", async () => {
		const f = await fixture();
		const r = await runJson<{
			tree: { id: string; children: { id: string; children: { id: string }[] }[] }[];
			tensions: unknown[];
			overrides: unknown[];
			ideas: number;
		}>(["prime"], f.root, { tty: false });
		expect(r.exitCode).toBe(0);
		expect(r.body.tree.map((n) => n.id)).toEqual([f.goal, f.auth]);
		expect(r.body.tree[0]?.children[0]?.id).toBe(f.sync);
		expect(r.body.tree[0]?.children[0]?.children[0]?.id).toBe(f.queue);
		expect(r.body.tensions).toEqual([{ edge: "e-0003", a: f.sync, b: f.auth }]);
		expect(r.body.overrides).toEqual([{ id: f.queue, slug: "queue", tier: 0 }]);
		expect(r.body.ideas).toBe(4);

		const md = (await run(["prime"], f.root)).stdout;
		expect(md).toStartWith("# Roots: project intent\n");
		expect(md).toContain(`- ${f.goal} goal [planted]: Field users never lose work`);
		expect(md).toContain(`  - ${f.sync} sync-works-offline [planted]: Sync works offline`);
		expect(md).toContain(`    - ${f.queue} queue [planted · tier 0]`);
		expect(md).toContain("## Tensions");
		expect(md).toContain("luuna-roots ask <id>");
		expect(md).toContain("2 propose: tier 1 + proposals and sprouts  ← this project");
		expect(md).toContain("luuna-roots propose edge <a> <b> <serves|tension|replaces>");
		expect(md).toContain("Rejected proposals are permanent");
		expect(md).not.toContain("Old idea");
	});

	test("--scope shows one subtree and what it serves", async () => {
		const f = await fixture();
		const r = await runJson<{ scope: string; serves: unknown[]; tree: { id: string }[] }>(
			["prime", "--scope", "sync-works"],
			f.root,
		);
		expect(r.body.scope).toBe(f.sync);
		expect(r.body.tree.map((n) => n.id)).toEqual([f.sync]);
		expect(r.body.serves).toEqual([{ id: f.goal, slug: "goal" }]);
		const md = (await run(["prime", "--scope", f.sync], f.root)).stdout;
		expect(md).toContain(`Serves: ${f.goal} goal`);
	});

	test("empty project", async () => {
		const root = await initProject();
		expect((await run(["prime"], root)).stdout).toContain("(no ideas yet)");
	});
});
