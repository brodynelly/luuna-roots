import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { lineHash } from "../blame.ts";
import { findNode, readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { readNodeProse } from "../prose.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

async function fixture() {
	const root = await initProject();
	const id = await plant(root, "Sync works offline", ["--slug", "offline-sync"]);
	const paths = rootsPaths(root);
	const node = findNode(readGraph(paths), id);
	const file = node ? readNodeProse(paths, node).path : null;
	if (!file) throw new Error("no file");
	writeFileSync(file, `${readFileSync(file, "utf8")}\nDone: a day in airplane mode.\n`);
	appendFileSync(
		paths.questions,
		`${JSON.stringify({ id: "q-0001", node: id, text: "What would make this done?", by: "roots:missing-done", status: "answered", createdAt: "2026-09-28T10:00:00Z" })}\n`,
	);
	appendFileSync(
		paths.events,
		`${JSON.stringify({ type: "answer", by: "human:h", at: "2026-09-28T10:05:00Z", node: id, question: "q-0001", session: "ss-0001", span: { from: 3, to: 3, removed: 0 }, lines: [lineHash("Done: a day in airplane mode.")] })}\n`,
	);
	return { root, id };
}

describe("luuna-roots blame", () => {
	test("--json attributes lines to questions", async () => {
		const { root, id } = await fixture();
		const { exitCode, body } = await runJson<{
			success: boolean;
			node: string;
			lines: Array<{ text: string; question: string | null }>;
			answers: Array<{ question: string; lines: number }>;
		}>(["blame", "offline-sync"], root);
		expect(exitCode).toBe(0);
		expect(body.success).toBe(true);
		expect(body.node).toBe(id);
		expect(body.lines.find((l) => l.text.startsWith("Done"))?.question).toBe("q-0001");
		expect(body.lines[0]?.question).toBeNull();
		expect(body.answers).toMatchObject([{ question: "q-0001", lines: 1 }]);
	});

	test("human output shows the question id in the margin and the question text", async () => {
		const { root } = await fixture();
		const r = await run(["blame", "offline-sync"], root);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toMatch(/q-0001\s+│ Done: a day in airplane mode\./);
		expect(r.stdout).toContain("What would make this done?");
		expect(r.stdout).toContain("1 line");
	});
});
