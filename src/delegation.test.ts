// Delegated questions: [a] → delegate event → agent.command attaches findings
// with `luuna-roots note --question` → the question is open again with its finding.
// The agent is a real shell script calling the real CLI.

import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, type RootsConfig } from "./config.ts";
import {
	DELEGATE_INSTRUCTION,
	delegationPrompt,
	findingPreview,
	firstParagraph,
	PREVIEW_MAX,
	runDelegation,
} from "./delegation.ts";
import { readEvents } from "./events.ts";
import { findNode, readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import {
	addQuestions,
	delegateQuestion,
	dueQuestions,
	isDue,
	readQuestions,
	undelegateQuestion,
} from "./questions.ts";
import { CLI_ENTRY, initProject, plant } from "./test-helpers.ts";
import type { NodeRecord } from "./types.ts";

const NOW = new Date("2026-09-28T12:00:00Z");
const ACT = { by: "human:t", session: "ss-0001", at: NOW };
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" };

function agentScript(dir: string, body: string): string {
	const file = join(dir, "agent.sh");
	writeFileSync(file, `#!/bin/sh\nroots() { bun "${CLI_ENTRY}" "$@"; }\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

function config(command: string | null): RootsConfig {
	return { ...defaultConfig("p"), agent: { command, timeoutSeconds: 20 } };
}

async function setup() {
	const root = await initProject();
	const id = await plant(root, "Sync works offline");
	const paths = rootsPaths(root);
	const qs = await addQuestions(
		paths,
		[
			{
				node: id,
				text: "What does Postgres do on a conflicting upsert?",
				by: "roots:missing-done",
			},
			{ node: id, text: "Which services already sync?", by: "agent:opus" },
		],
		{ session: "ss-0001", now: NOW },
	);
	const node = findNode(readGraph(paths), id) as NodeRecord;
	return { root, id, paths, node, q: qs.map((x) => x.id) as [string, string] };
}

describe("delegate / undelegate", () => {
	test("delegated questions are not due; each change logs one event", async () => {
		const { paths, q } = await setup();
		const d = await delegateQuestion(paths, q[0], ACT);
		expect(d).toMatchObject({ status: "delegated", delegatedBy: "human:t", session: "ss-0001" });
		expect(isDue(d, NOW)).toBe(false);
		const back = await undelegateQuestion(paths, q[0], "no findings", NOW);
		expect(back?.status).toBe("open");
		expect(await undelegateQuestion(paths, q[0], "again", NOW)).toBeNull();
		const events = readEvents(paths).filter((e) => e.question === q[0]);
		expect(events.map((e) => [e.type, e.by])).toEqual([
			["ask", "roots:missing-done"],
			["delegate", "human:t"],
			["undelegate", "roots"],
		]);
	});

	test("questions with findings come first", () => {
		const base = { node: "r-1", by: "roots:x", status: "open" as const, text: "?" };
		const rows = [
			{ ...base, id: "q-1", createdAt: "2026-01-01" },
			{
				...base,
				id: "q-2",
				createdAt: "2026-02-01",
				findings: [{ note: "n.md", by: "agent:a", at: "" }],
			},
		];
		expect(dueQuestions(rows, "r-1", NOW).map((x) => x.id)).toEqual(["q-2", "q-1"]);
	});
});

describe("runDelegation", () => {
	test("the agent attaches findings; the question reopens with them", async () => {
		const { root, id, paths, node, q } = await setup();
		await delegateQuestion(paths, q[0], ACT);
		const agent = agentScript(
			root,
			[
				"cat > prompt.txt",
				`printf '# Upserts\\n\\nPostgres raises unless ON CONFLICT is given.\\n\\nDetails.\\n' > findings.md`,
				`luuna-roots note ${id} --question ${q[0]} --file findings.md`,
			].join("\n"),
		);
		const r = await runDelegation({
			paths,
			config: config(agent),
			node,
			session: "ss-0002",
			env: ENV,
		});
		expect(r?.run.status).toBe("ok");
		expect(readFileSync(join(root, "prompt.txt"), "utf8")).toContain(
			`- ${q[0]}: What does Postgres`,
		);
		expect(r?.found).toEqual([q[0]]);
		expect(r?.returned).toEqual([]);
		const back = readQuestions(paths).find((x) => x.id === q[0]);
		expect(back?.status).toBe("open");
		expect(back?.findings?.[0]?.by).toBe("agent:agent-sh");
		expect(findingPreview(paths, back ?? {})).toMatchObject({
			text: "Postgres raises unless ON CONFLICT is given.",
			by: "agent:agent-sh",
		});
		const note = readEvents(paths).find((e) => e.type === "note");
		expect(note?.question).toBe(q[0]);
	});

	test("no findings, or a failed run: the question goes back to the human", async () => {
		const { root, paths, node, q } = await setup();
		await delegateQuestion(paths, q[0], ACT);
		const quiet = await runDelegation({
			paths,
			config: config(agentScript(root, "exit 0")),
			node,
			session: "ss-0002",
			env: ENV,
		});
		expect(quiet?.returned).toEqual([q[0]]);
		expect(readQuestions(paths).find((x) => x.id === q[0])?.status).toBe("open");
		await delegateQuestion(paths, q[0], ACT);
		const failed = await runDelegation({
			paths,
			config: config(agentScript(root, "exit 4")),
			node,
			session: "ss-0003",
			env: ENV,
		});
		expect(failed?.run.error).toBe("exited with code 4");
		const undo = readEvents(paths).filter((e) => e.type === "undelegate");
		expect(undo.map((e) => e.reason)).toEqual(["no findings", "agent.command exited with code 4"]);
	});

	test("nothing to do: no command, tier 0, or nothing delegated", async () => {
		const { root, paths, node, q } = await setup();
		const input = { paths, node, session: "ss-0002", env: ENV };
		expect(await runDelegation({ ...input, config: config(agentScript(root, "")) })).toBeNull();
		await delegateQuestion(paths, q[0], ACT);
		expect(await runDelegation({ ...input, config: config(null) })).toBeNull();
		const off: RootsConfig = { ...config("true"), tier: 0 as RootsConfig["tier"] };
		expect(await runDelegation({ ...input, config: off })).toBeNull();
		expect(readQuestions(paths).find((x) => x.id === q[0])?.status).toBe("delegated");
	});
});

describe("findings text", () => {
	test("firstParagraph skips headings, rules and fences", () => {
		expect(firstParagraph("---\n# Title\n\n## Sub\nThe answer\nspans lines.\n\nMore.")).toBe(
			"The answer spans lines.",
		);
		expect(firstParagraph("# only a heading\n")).toBe("");
	});

	test("findingPreview: latest finding, capped, missing file", async () => {
		const root = await initProject();
		writeFileSync(join(root, "a.md"), "old");
		writeFileSync(join(root, "b.md"), "x".repeat(PREVIEW_MAX + 50));
		const paths = rootsPaths(root);
		const f = (note: string) => ({ note, by: "agent:a", at: "" });
		const p = findingPreview(paths, { findings: [f("a.md"), f("b.md")] });
		expect(p?.path).toBe("b.md");
		expect(p?.text).toHaveLength(PREVIEW_MAX);
		expect(findingPreview(paths, { findings: [f("gone.md")] })?.text).toBe("(the note is missing)");
		expect(findingPreview(paths, {})).toBeNull();
	});

	test("the prompt lists the delegated questions and earlier findings", () => {
		const prompt = delegationPrompt(
			"# packet",
			[
				{
					id: "q-1",
					node: "r-1",
					text: "Which services sync?",
					by: "roots:x",
					status: "delegated",
					createdAt: "",
					findings: [{ note: "old.md", by: "agent:a", at: "" }],
				},
			],
			{ id: "r-1", slug: "sync", actor: "agent:opus" },
		);
		expect(prompt).toContain(
			"luuna-roots note r-1 --question <q-id> --file <findings.md> --as agent:opus",
		);
		expect(prompt).toContain("- q-1: Which services sync?\n  - earlier findings: old.md");
		expect(prompt.endsWith("# packet")).toBe(true);
		expect(DELEGATE_INSTRUCTION).toContain("Do not\n  decide for them.");
	});
});
