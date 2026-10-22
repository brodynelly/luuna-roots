import { describe, expect, test } from "bun:test";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { findNode, readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { forceStatus, initProject, plant, run, runJson } from "../test-helpers.ts";

describe("luuna-roots commit / status / compost", () => {
	test("forward along the lifecycle, one event per change", async () => {
		const root = await initProject();
		const paths = rootsPaths(root);
		const id = await plant(root, "Sync works offline");
		const early = await runJson<{ error: string }>(["commit", id], root, { tty: false });
		expect(early.exitCode).toBe(EXIT.conflict);
		expect(early.body.error).toContain(`luuna-roots think ${id}`);
		await forceStatus(root, id, "shaping");
		const c = await runJson(["commit", id], root, { tty: false });
		expect(c.body).toMatchObject({ changed: true, from: "shaping", to: "committed" });
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "status",
			by: "human:test-human",
			node: id,
			from: "shaping",
			to: "committed",
		});
		expect((await runJson(["commit", id], root)).body).toMatchObject({ changed: false });
		const built = await run(["status", id, "built"], root);
		expect(built.stdout).toContain("committed → built");
		const shaping = await runJson<{ error: string }>(["status", id, "shaping"], root);
		expect(shaping.body.error).toContain("first `luuna-roots think`");
		expect((await runJson(["status", id, "done"], root)).exitCode).toBe(EXIT.usage);
		const compost = await runJson(["compost", id, "--reason", "shipped and forgotten"], root);
		expect(compost.body).toMatchObject({ from: "built", to: "composted" });
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "compost",
			reason: "shipped and forgotten",
			from: "built",
		});
		const back = await runJson<{ error: string }>(["status", id, "committed"], root);
		expect(back.body.error).toContain("stay composted");
		expect(findNode(readGraph(paths), id)?.status).toBe("composted");
	});

	test("human only", async () => {
		const root = await initProject();
		const id = await plant(root, "Idea");
		const r = await runJson(["compost", id], root, { env: { ROOTS_AGENT: "agent:x" } });
		expect(r.exitCode).toBe(EXIT.guard);
	});
});
