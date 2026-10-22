import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { EXIT } from "../errors.ts";
import { rootsPaths } from "../paths.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

interface ListBody {
	count: number;
	nodes: { id: string; slug: string; status: string; kind: string; statement: string }[];
}

function add(root: string, records: object[]): void {
	appendFileSync(rootsPaths(root).graph, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

const at = "2026-09-28T12:00:00Z";

async function fixture() {
	const root = await initProject();
	const a = await plant(root, "Anchor goal", ["--slug", "anchor"]);
	const b = await plant(root, "Means to it", ["--slug", "means"]);
	const c = await plant(root, "Lonely thought", ["--slug", "lonely"]);
	const d = await plant(root, "Old idea", ["--slug", "old"]);
	add(root, [
		{ type: "edge", id: "e-0001", from: b, to: a, rel: "serves", by: "human:x", createdAt: at },
		{
			type: "node",
			id: d,
			kind: "idea",
			slug: "old",
			status: "composted",
			author: "human:x",
			createdAt: at,
		},
		{
			type: "node",
			id: "s-0001",
			kind: "sprout",
			slug: "sprouty",
			status: "open",
			author: "agent:m",
			createdAt: at,
		},
		{
			type: "node",
			id: "s-0002",
			kind: "sprout",
			slug: "rejected-one",
			status: "rejected",
			author: "agent:m",
			createdAt: at,
		},
	]);
	return { root, a, b, c, d };
}

const slugs = (b: ListBody) => b.nodes.map((n) => n.slug);

describe("luuna-roots list", () => {
	test("default hides composted ideas and closed sprouts; ideas first", async () => {
		const { root } = await fixture();
		const { body } = await runJson<ListBody>(["list"], root);
		expect(slugs(body)).toEqual(["anchor", "means", "lonely", "sprouty"]);
		expect(body.count).toBe(4);
		expect(body.nodes[0]?.statement).toBe("Anchor goal");
	});

	test("--all, --status, --kind", async () => {
		const { root } = await fixture();
		expect(slugs((await runJson<ListBody>(["list", "--all"], root)).body)).toHaveLength(6);
		expect(slugs((await runJson<ListBody>(["list", "--status", "composted"], root)).body)).toEqual([
			"old",
		]);
		expect(slugs((await runJson<ListBody>(["list", "--status", "rejected"], root)).body)).toEqual([
			"rejected-one",
		]);
		expect(slugs((await runJson<ListBody>(["list", "--kind", "sprout"], root)).body)).toEqual([
			"sprouty",
		]);
	});

	test("--orphans and --anchors", async () => {
		const { root } = await fixture();
		expect(slugs((await runJson<ListBody>(["list", "--orphans"], root)).body)).toEqual([
			"lonely",
			"sprouty",
		]);
		expect(slugs((await runJson<ListBody>(["list", "--anchors"], root)).body)).toEqual([
			"anchor",
			"lonely",
		]);
		expect(slugs((await runJson<ListBody>(["list", "--anchors", "--orphans"], root)).body)).toEqual(
			["lonely"],
		);
	});

	test("invalid filters are usage errors", async () => {
		const { root } = await fixture();
		expect((await run(["list", "--status", "nope"], root)).exitCode).toBe(EXIT.usage);
		expect((await run(["list", "--kind", "edge"], root)).exitCode).toBe(EXIT.usage);
		expect((await run(["list", "extra"], root)).exitCode).toBe(EXIT.usage);
	});

	test("human output", async () => {
		const { root } = await fixture();
		const out = (await run(["list"], root)).stdout.split("\n");
		expect(out[0]).toMatch(/^r-[0-9a-f]{4} anchor\s+planted\s+Anchor goal$/);
		expect(out.find((l) => l.includes("sprouty"))).toMatch(/^\[agent\] s-0001 sprouty\s+open/);
		const empty = await initProject();
		expect((await run(["list"], empty)).stdout).toContain("No ideas yet");
		expect((await run(["list", "--status", "built"], root)).stdout).toContain("No matches.");
	});
});
