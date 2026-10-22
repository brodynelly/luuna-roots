import { describe, expect, test } from "bun:test";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { findNode, readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { forceStatus, initProject, plant, run, runJson } from "../test-helpers.ts";
import type { EdgeRecord } from "../types.ts";

async function setup() {
	const root = await initProject();
	const a = await plant(root, "Sync works offline");
	const b = await plant(root, "Local first storage");
	return { root, a, b, paths: rootsPaths(root) };
}

describe("luuna-roots link / unlink", () => {
	test("link adds a human edge (no TTY needed); unlink removes it; one event each", async () => {
		const { root, a, b, paths } = await setup();
		const r = await runJson<{ id: string; edge: EdgeRecord }>(
			["link", a, "local-first-storage", "serves"],
			root,
			{ tty: false },
		);
		expect(r.exitCode).toBe(0);
		expect(r.body.edge).toMatchObject({ from: a, to: b, rel: "serves", by: "human:test-human" });
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "link",
			node: a,
			refs: [b],
			edge: r.body.id,
		});
		const shown = await run(["show", a], root);
		expect(shown.stdout).toContain(`(${r.body.id})`);
		const u = await runJson(["unlink", r.body.id], root, { tty: false });
		expect(u.exitCode).toBe(0);
		expect(readGraph(paths).edges).toHaveLength(0);
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "unlink",
			edge: r.body.id,
			rel: "serves",
		});
		expect((await runJson(["unlink", r.body.id], root)).exitCode).toBe(EXIT.notFound);
	});

	test("replaces composts the target (status event); invariants enforced", async () => {
		const { root, a, b, paths } = await setup();
		const r = await runJson<{ composted: unknown }>(["link", a, b, "replaces"], root);
		expect(r.body.composted).toEqual({ node: b, from: "planted", to: "composted" });
		expect(findNode(readGraph(paths), b)?.status).toBe("composted");
		expect(readEvents(paths).at(-1)).toMatchObject({ type: "status", node: b, to: "composted" });
		const c = await plant(root, "Conflict free merges");
		await run(["link", a, c, "tension"], root);
		const dup = await runJson<{ error: string }>(["link", c, a, "tension"], root);
		expect(dup.exitCode).toBe(EXIT.validation);
		expect(dup.body.error).toContain("already exists");
		const self = await runJson<{ error: string }>(["link", a, a, "serves"], root);
		expect(self.body.error).toContain("itself");
		const rel = await runJson<{ error: string }>(["link", a, c, "derives"], root);
		expect(rel.body.error).toContain("luuna-roots adopt");
		const bad = await runJson<{ error: string }>(["link", a, c, "blocks"], root);
		expect(bad.exitCode).toBe(EXIT.usage);
	});

	test("derives edges stay; agents cannot link", async () => {
		const { root, a, b, paths } = await setup();
		await forceStatus(root, b, "shaping");
		const agent = await runJson(["link", a, b, "serves"], root, {
			env: { ROOTS_AGENT: "agent:x" },
		});
		expect(agent.exitCode).toBe(EXIT.guard);
		const anon = await runJson(["link", a, b, "serves"], root, {
			env: { ROOTS_USER: undefined, HOME: "/nonexistent" },
		});
		expect(anon.exitCode).toBe(EXIT.guard);
		const { appendFileSync } = await import("node:fs");
		appendFileSync(
			paths.graph,
			`${JSON.stringify({ type: "edge", id: "e-dddd", from: a, to: "s-9f3e", rel: "derives", by: "human:x", createdAt: "2026-09-28T10:00:00Z" })}\n`,
		);
		const u = await runJson<{ error: string }>(["unlink", "e-dddd"], root);
		expect(u.body.error).toContain("lineage");
	});
});
