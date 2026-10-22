import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../errors.ts";
import { readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { initProject, patchConfig, plant, run, runJson } from "../test-helpers.ts";

const AGENT = ["--as", "agent:opus"];

type Sprouted = { id: string; slug: string; path: string; expiresAt: string; error?: string };

describe("luuna-roots sprout", () => {
	test("files a sprout with an optional body from --file", async () => {
		const root = await initProject();
		writeFileSync(join(root, "why.md"), "Users lose edits today.\n");
		const r = await runJson<Sprouted>(
			["sprout", "Conflicts", "get", "a", "merge", "UI", "--file", "why.md", ...AGENT],
			root,
			{ tty: false },
		);
		expect(r.exitCode).toBe(0);
		expect(r.body.path).toBe(
			`.luuna/roots/agent/sprouts/${r.body.id.slice(2)}-conflicts-get-merge-ui/sprout.md`,
		);
		expect(readFileSync(join(root, r.body.path), "utf8")).toBe(
			"Conflicts get a merge UI\n\nUsers lose edits today.\n",
		);
		const node = readGraph(rootsPaths(root)).nodes.find((n) => n.id === r.body.id);
		expect(node).toMatchObject({ kind: "sprout", status: "open", author: "agent:opus" });
		const days = (Date.parse(r.body.expiresAt) - Date.now()) / 86_400_000;
		expect(Math.round(days)).toBe(30);
	});

	test("identity: --as or ROOTS_AGENT; never human", async () => {
		const root = await initProject();
		expect((await run(["sprout", "x"], root, { tty: false })).exitCode).toBe(EXIT.guard);
		const human = await runJson(["sprout", "x", "--as", "human:jay"], root);
		expect(human.exitCode).toBe(EXIT.guard);
		const env = await runJson<Sprouted>(["sprout", "From env"], root, {
			env: { ROOTS_AGENT: "agent:haiku" },
		});
		expect(env.exitCode).toBe(0);
	});

	test("refused below tier 2, at the cap, and for duplicates", async () => {
		const root = await initProject();
		await plant(root, "Sync works offline");
		const dup = await runJson<Sprouted>(["sprout", "sync works offline", ...AGENT], root);
		expect(dup.exitCode).toBe(EXIT.validation);
		expect(dup.body.error).toContain("already has this idea");
		const missing = await runJson(["sprout", "x", "--file", "nope.md", ...AGENT], root);
		expect(missing.exitCode).toBe(EXIT.notFound);
		await patchConfig(root, { tier: 1 });
		const low = await runJson<Sprouted>(["sprout", "New thing", ...AGENT], root);
		expect(low.exitCode).toBe(EXIT.guard);
		expect(low.body.error).toContain("tier 2");
	});
});
