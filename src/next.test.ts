import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextStep } from "./next.ts";
import { rootsPaths } from "./paths.ts";
import { addQuestions, delegateQuestion } from "./questions.ts";
import { initProject, plant, run } from "./test-helpers.ts";

const now = () => new Date();

describe("nextStep", () => {
	test("empty project → plant", async () => {
		const root = await initProject();
		expect(nextStep(rootsPaths(root), now())).toEqual({
			command: 'luuna-roots plant "<one sentence>"',
			reason: "nothing needs thinking",
		});
	});

	test("an idea with rule questions → think it; exclude prefers another idea", async () => {
		const root = await initProject();
		const a = await plant(root, "Sync works offline");
		const b = await plant(root, "Server is authoritative");
		const first = nextStep(rootsPaths(root), now());
		expect(first.command).toMatch(/^luuna-roots think r-/);
		expect(first.reason).toMatch(/new question/);
		const other = first.command.endsWith(a) ? b : a;
		const excluded = first.command.split(" ").pop();
		expect(nextStep(rootsPaths(root), now(), excluded).command).toBe(`luuna-roots think ${other}`);
	});

	test("returned agent findings put their idea first", async () => {
		const root = await initProject();
		const paths = rootsPaths(root);
		await plant(root, "Sync works offline");
		const b = await plant(root, "Server is authoritative");
		const [q] = await addQuestions(paths, [{ node: b, text: "Who wins?", by: "roots:x" }]);
		await delegateQuestion(paths, q?.id ?? "", { by: "human:t", session: "ss-0001" });
		writeFileSync(join(root, "f.md"), "Last write wins today.\n");
		await run(["note", b, "--file", "f.md", "--question", q?.id ?? "", "--as", "agent:a"], root);
		expect(nextStep(paths, now())).toEqual({
			command: `luuna-roots think ${b}`,
			reason: "server-authoritative: agent findings ready",
		});
	});

	test("exclude falls back to the only idea in need", async () => {
		const root = await initProject();
		const a = await plant(root, "Sync works offline");
		expect(nextStep(rootsPaths(root), now(), a).command).toBe(`luuna-roots think ${a}`);
	});

	test("cards waiting → tend first", async () => {
		const root = await initProject();
		await plant(root, "Sync works offline");
		await run(["sprout", "Conflicts get a merge UI", "--as", "agent:opus"], root);
		expect(nextStep(rootsPaths(root), now())).toEqual({
			command: "luuna-roots tend",
			reason: "1 sprout waiting for review",
		});
	});
});

describe("next: line", () => {
	test("plant prints the next step; --json and --quiet do not", async () => {
		const root = await initProject();
		const r = await run(["plant", "Sync works offline"], root);
		expect(r.stdout + r.stderr).toMatch(/next: luuna-roots think r-[0-9a-f]{4} — sync-works-offline/);
		const q = await run(["plant", "Another idea", "--quiet"], root);
		expect(q.stdout + q.stderr).not.toContain("next:");
	});
});
