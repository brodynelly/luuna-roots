import { describe, expect, test } from "bun:test";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { findNode, readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

describe("luuna-roots tier", () => {
	test("sets and clears the per-idea override; one tier event per change", async () => {
		const root = await initProject();
		const id = await plant(root, "Think about this alone");
		const paths = rootsPaths(root);
		const set = await runJson(["tier", id, "0"], root, { tty: false });
		expect(set.exitCode).toBe(0);
		expect(set.body).toMatchObject({ id, changed: true, tier: 0, name: "off", source: "idea" });
		expect(findNode(readGraph(paths), id)?.tier).toBe(0);
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "tier",
			by: "human:test-human",
			node: id,
			from: null,
			to: 0,
		});
		const same = await runJson(["tier", id, "off"], root);
		expect(same.body).toMatchObject({ changed: false });
		const shown = await runJson(["tier", id], root);
		expect(shown.body).toMatchObject({ tier: 0, source: "idea", config: 2 });
		const cleared = await runJson(["tier", id, "default"], root);
		expect(cleared.body).toMatchObject({
			changed: true,
			override: null,
			tier: 2,
			source: "config",
		});
		expect(findNode(readGraph(paths), id)?.tier).toBeUndefined();
		expect(readEvents(paths).filter((e) => e.type === "tier")).toHaveLength(2);
		const human = await run(["tier", id], root);
		expect(human.stdout).toContain("tier 2 (propose, from config.yaml)");
	});

	test("refuses bad tiers, agents, and anonymous humans", async () => {
		const root = await initProject();
		const id = await plant(root, "Idea");
		expect((await runJson(["tier", id, "4"], root)).exitCode).toBe(EXIT.usage);
		const agent = await runJson<{ error: string }>(["tier", id, "3"], root, {
			env: { ROOTS_AGENT: "agent:opus" },
		});
		expect(agent.exitCode).toBe(EXIT.guard);
		expect(agent.body.error).toContain("ROOTS_AGENT");
		const anon = await runJson(["tier", id, "3"], root, {
			env: { ROOTS_USER: undefined, HOME: "/nonexistent" },
		});
		expect(anon.exitCode).toBe(EXIT.guard);
		expect(findNode(readGraph(rootsPaths(root)), id)?.tier).toBeUndefined();
	});
});
