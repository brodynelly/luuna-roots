import { describe, expect, test } from "bun:test";
import { EXIT } from "../errors.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

interface LogBody {
	node: string | null;
	count: number;
	events: { type: string; node?: string; by: string }[];
}

describe("luuna-roots log", () => {
	test("all events, filtered by node, limited", async () => {
		const root = await initProject();
		const a = await plant(root, "Alpha", ["--slug", "alpha"]);
		await plant(root, "Beta", ["--slug", "beta"]);
		await run(["mv", "alpha", "alpha-2"], root);
		const all = (await runJson<LogBody>(["log"], root)).body;
		expect(all.events.map((e) => e.type)).toEqual(["init", "plant", "plant", "mv"]);
		const one = (await runJson<LogBody>(["log", a], root)).body;
		expect(one.node).toBe(a);
		expect(one.events.map((e) => e.type)).toEqual(["plant", "mv"]);
		const last = (await runJson<LogBody>(["log", "-n", "1"], root)).body;
		expect(last.events.map((e) => e.type)).toEqual(["mv"]);
		expect((await runJson<LogBody>(["log", "--limit", "0"], root)).body.count).toBe(0);
	});

	test("human output", async () => {
		const root = await initProject();
		await plant(root, "Alpha", ["--slug", "alpha"]);
		await run(["mv", "alpha", "beta"], root);
		const out = (await run(["log"], root)).stdout;
		expect(out).toMatch(
			/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+plant\s+r-[0-9a-f]{4} beta\s+human:test-human/,
		);
		expect(out).toContain("alpha → beta");
		expect(out).toContain("project=");
		expect((await run(["log", "--limit", "0"], root)).stdout).toBe("No events.\n");
	});

	test("errors", async () => {
		const root = await initProject();
		expect((await run(["log", "nope"], root)).exitCode).toBe(EXIT.notFound);
		expect((await run(["log", "-n", "x"], root)).exitCode).toBe(EXIT.usage);
	});
});
