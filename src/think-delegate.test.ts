// [a] in think, end to end: the human hands a question to the agent, the
// research run after the session attaches findings, and the next session
// shows them under the question. The agent is a real shell script: it asks
// nothing before a session and answers "## Delegated questions" prompts.

import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeColors } from "./color.ts";
import { defaultConfig, type RootsConfig } from "./config.ts";
import { findNode, readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { readQuestions } from "./questions.ts";
import type { StatusLine } from "./spinner.ts";
import { CLI_ENTRY, fakeTerminal, initProject, plant, waitFor } from "./test-helpers.ts";
import { type BackgroundJob, runThinkSession, type ThinkDeps } from "./think-session.ts";

const WATCH = { debounceMs: 20, pollMs: 50 };
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" };

const RESEARCHER = `#!/bin/sh
roots() { bun "${CLI_ENTRY}" "$@"; }
input=$(cat)
case "$input" in
*"## Delegated questions"*)
	q=$(printf '%s\\n' "$input" | sed -n 's/^- \\(q-[0-9a-f]*\\): .*/\\1/p' | head -n 1)
	printf '# Findings\\n\\nThree services sync today: api, worker and mobile.\\n\\nSources below.\\n' > findings.md
	luuna-roots note "$ROOTS_NODE" --question "$q" --file findings.md
	;;
esac
`;

async function setup() {
	const root = await initProject();
	const id = await plant(root, "Sync works offline");
	const file = join(root, "agent.sh");
	writeFileSync(file, RESEARCHER);
	chmodSync(file, 0o755);
	const config: RootsConfig = {
		...defaultConfig("p"),
		agent: { command: file, timeoutSeconds: 20 },
	};
	return { root, id, paths: rootsPaths(root), config };
}

function deps(root: string, id: string, config: RootsConfig, over: Partial<ThinkDeps> = {}) {
	const paths = rootsPaths(root);
	const node = findNode(readGraph(paths), id);
	if (!node) throw new Error("no node");
	const statuses: string[] = [];
	const d: ThinkDeps = {
		paths,
		config,
		node,
		by: "human:test-human",
		terminal: fakeTerminal(70, 40),
		colors: makeColors(false),
		editorHint: "Open idea.md in another pane.",
		watch: WATCH,
		env: ENV,
		agentStatus: (text): StatusLine => {
			statuses.push(text);
			return { stop: (final) => statuses.push(`stop:${final ?? ""}`) };
		},
		...over,
	};
	return { d, terminal: d.terminal as ReturnType<typeof fakeTerminal>, statuses };
}

describe("[a] ask agent", () => {
	test("delegate → research after the session → findings under the question next time", async () => {
		const { root, id, paths, config } = await setup();
		const one = deps(root, id, config);
		const run1 = runThinkSession(one.d);
		await waitFor(() => one.terminal.screen().includes("question 1/"), 15000, "question");
		expect(one.terminal.screen()).toContain("[a] ask agent");
		const first = readQuestions(paths).find((q) => q.session !== undefined && q.status === "open");
		one.terminal.send("a");
		await waitFor(() => one.terminal.screen().includes("handed to the agent"), 3000, "delegated");
		one.terminal.send("q");
		const s1 = await run1;
		expect(s1.tally.delegated).toBe(1);
		expect(s1.delegation).toMatchObject({ status: "ok", returned: [] });
		expect(s1.delegation?.found).toHaveLength(1);
		expect(one.statuses.some((t) => t.includes("is researching 1 question"))).toBe(true);
		const q = readQuestions(paths).find((x) => x.id === s1.delegation?.found[0]);
		expect(q?.status).toBe("open");
		expect(q?.text).toBe(first?.text ?? "");

		const two = deps(root, id, config);
		const run2 = runThinkSession(two.d);
		await waitFor(
			() => two.terminal.screen().includes("── findings ── [agent]"),
			15000,
			"findings",
		);
		const screen = two.terminal.screen();
		expect(screen).toContain("question 1/");
		expect(screen).toContain(q?.text.slice(0, 30) ?? "?");
		expect(screen).toContain("Three services sync today: api, worker and mobile.");
		expect(screen).toContain("full: .luuna/roots/agent/notes/");
		two.terminal.send("q");
		expect((await run2).delegation).toBeNull();
	}, 40000);

	test("background mode (flow) hands the research run to the caller", async () => {
		const { root, id, paths, config } = await setup();
		const jobs: BackgroundJob[] = [];
		const { d, terminal } = deps(root, id, config, { background: (j) => jobs.push(j) });
		const running = runThinkSession(d);
		await waitFor(() => terminal.screen().includes("question 1/"), 15000, "question");
		terminal.send("a");
		await waitFor(() => terminal.screen().includes("handed to the agent"), 3000, "delegated");
		terminal.send("q");
		const s = await running;
		expect(s.delegation?.status).toBe("background");
		const job = jobs.find((j) => j.label.startsWith("researching 1 question"));
		expect(job).toBeDefined();
		expect(await job?.done).toBeNull();
		const q = readQuestions(paths).find((x) => x.id === s.delegation?.questions[0]);
		expect(q?.findings).toHaveLength(1);
	}, 40000);
});
