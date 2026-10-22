// think + agents (tier ≥ 1): agent.command before the session, live
// arrivals from a harness during it. The agent is a real shell script that
// calls the real CLI.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeColors } from "./color.ts";
import { defaultConfig, type RootsConfig } from "./config.ts";
import { findNode, readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { addQuestions, readQuestions } from "./questions.ts";
import type { StatusLine } from "./spinner.ts";
import { CLI_ENTRY, fakeTerminal, initProject, plant, runJson, waitFor } from "./test-helpers.ts";
import { type BackgroundJob, runThinkSession, type ThinkDeps } from "./think-session.ts";

const WATCH = { debounceMs: 20, pollMs: 50 };
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" };

function agentScript(dir: string, body: string): string {
	const file = join(dir, "agent.sh");
	writeFileSync(file, `#!/bin/sh\nroots() { bun "${CLI_ENTRY}" "$@"; }\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

function config(command: string | null, over: Partial<RootsConfig> = {}): RootsConfig {
	const c = defaultConfig("p");
	return { ...c, agent: { command, timeoutSeconds: 20 }, ...over };
}

async function setup(statement = "Sync works offline") {
	const root = await initProject();
	const id = await plant(root, statement);
	return { root, id, paths: rootsPaths(root) };
}

function deps(root: string, id: string, over: Partial<ThinkDeps> = {}) {
	const paths = rootsPaths(root);
	const node = findNode(readGraph(paths), id);
	if (!node) throw new Error("no node");
	const statuses: string[] = [];
	const d: ThinkDeps = {
		paths,
		config: config(null),
		node,
		by: "human:test-human",
		terminal: fakeTerminal(70),
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

describe("think with agent.command", () => {
	test("agent questions are asked first and attached to the session", async () => {
		const { root, id, paths } = await setup();
		const agent = agentScript(
			root,
			[
				'cat > "$ROOTS_NODE.prompt"',
				'luuna-roots ask "$ROOTS_NODE" "What happens to an edit made offline on a deleted record?"',
				'luuna-roots ask "$ROOTS_NODE" "Who wins when two devices edit the same field offline?"',
			].join("\n"),
		);
		const { d, terminal, statuses } = deps(root, id, { config: config(agent) });
		const running = runThinkSession(d);
		await waitFor(() => terminal.screen().includes("question 1/3"), 15000, "first question");
		const screen = terminal.screen();
		expect(screen).toContain("[agent]");
		expect(screen).toContain("What happens to an edit made offline");
		expect(screen).toContain("the agent asked 2 questions");
		terminal.send("s");
		await waitFor(() => terminal.screen().includes("question 2/3"));
		expect(terminal.screen()).toContain("Who wins when two devices");
		terminal.send("s");
		await waitFor(() => terminal.screen().includes("question 3/3"));
		expect(terminal.screen()).toContain("[missing-done]");
		terminal.send("q");
		const s = await running;
		expect(s.agent).toMatchObject({
			mode: "command",
			actor: "agent:agent-sh",
			status: "ok",
			asked: 2,
			arrived: 0,
			error: null,
		});
		const agentQs = readQuestions(paths).filter((q) => q.by === "agent:agent-sh");
		expect(agentQs.map((q) => q.session)).toEqual([s.session, s.session]);
		expect(statuses[0]).toContain("asking agent:agent-sh for questions about sync-works-offline");
		expect(statuses[1]).toBe("stop:");
		const prompt = Bun.file(join(root, `${id}.prompt`));
		const text = await prompt.text();
		expect(text).toContain(`luuna-roots ask ${id} "<your question>" --as agent:agent-sh`);
		expect(text).toContain(`- think session: ${s.session}`);
	}, 30000);

	test("a failing or slow agent never blocks thinking", async () => {
		const { root, id } = await setup();
		const failing = agentScript(root, "exit 7");
		const one = deps(root, id, { config: config(failing) });
		const run1 = runThinkSession(one.d);
		await waitFor(() => one.terminal.screen().includes("question 1/2"), 5000);
		expect(one.terminal.screen()).toContain("agent unavailable (exited with code 7)");
		one.terminal.send("q");
		const s1 = await run1;
		expect(s1.agent).toMatchObject({ status: "failed", error: "exited with code 7" });
		expect(one.statuses.at(-1)).toContain("stop:! agent.command exited with code 7");

		const slow = agentScript(root, "sleep 30");
		const two = deps(root, id, { config: config(slow), agentTimeoutMs: 300 });
		const run2 = runThinkSession(two.d);
		await waitFor(() => two.terminal.screen().includes("question 1/2"), 5000);
		expect(two.terminal.screen()).toContain("timed out after 300ms");
		two.terminal.send("q");
		expect((await run2).agent.status).toBe("timeout");
	}, 20000);

	test("tier 0 (per-idea override): agent not run, queued agent questions left out", async () => {
		const { root, id, paths } = await setup();
		await runJson(["tier", id, "0"], root);
		await addQuestions(paths, [{ node: id, text: "Old agent question?", by: "agent:opus" }]);
		const marker = join(root, "ran");
		const agent = agentScript(root, `touch "${marker}"`);
		const { d, terminal } = deps(root, id, { config: config(agent) });
		const running = runThinkSession(d);
		await waitFor(() => terminal.screen().includes("question 1/2"), 5000);
		expect(terminal.screen()).not.toContain("Old agent question");
		terminal.send("q");
		const s = await running;
		expect(s.agent).toMatchObject({ mode: "off", tier: 0 });
		expect(existsSync(marker)).toBe(false);
	});

	test("skips the run when the idea already has its cap of agent questions", async () => {
		const { root, id, paths } = await setup();
		const drafts = [1, 2, 3].map((n) => ({ node: id, text: `Q${n}?`, by: "agent:opus" }));
		await addQuestions(paths, drafts);
		const marker = join(root, "ran");
		const { d, terminal } = deps(root, id, {
			config: config(agentScript(root, `touch "${marker}"`)),
		});
		const running = runThinkSession(d);
		await waitFor(() => terminal.screen().includes("question 1/3"), 5000);
		expect(terminal.screen()).toContain("Q1?");
		terminal.send("q");
		expect((await running).agent.mode).toBe("full");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("think with an already-running harness", () => {
	test("questions asked before the session come first; live asks join the queue", async () => {
		const { root, id } = await setup();
		await runJson(["ask", id, "Asked before the session?", "--as", "agent:opus"], root);
		const { d, terminal } = deps(root, id);
		const running = runThinkSession(d);
		await waitFor(() => terminal.screen().includes("question 1/3"), 5000);
		expect(terminal.screen()).toContain("Asked before the session?");
		// A harness asks mid-session: the last unreached rule question is bumped.
		const r = await runJson(["ask", id, "Asked during the session?", "--as", "agent:opus"], root);
		expect(r.exitCode).toBe(0);
		await waitFor(() => terminal.screen().includes("an agent asked 1 new question"), 5000);
		terminal.send("s");
		await waitFor(() => terminal.screen().includes("question 2/3"));
		expect(terminal.screen()).toContain("Asked during the session?");
		terminal.send("s");
		await waitFor(() => terminal.screen().includes("question 3/3"));
		expect(terminal.screen()).toContain("[missing-done]");
		terminal.send("q");
		const s = await running;
		expect(s.agent).toMatchObject({ mode: "harness", arrived: 1, asked: 0 });
		// The bumped rule question stays open for next time.
		expect(
			readQuestions(rootsPaths(root)).find((q) => q.by === "roots:missing-scope")?.status,
		).toBe("open");
	});
});

describe("think in background mode (flow)", () => {
	test("the session starts before the agent finishes; its questions arrive live", async () => {
		const { root, id } = await setup();
		const agent = agentScript(
			root,
			[
				"while [ ! -f go ]; do sleep 0.05; done",
				'luuna-roots ask "$ROOTS_NODE" "Which record wins after a delete?"',
			].join("\n"),
		);
		const jobs: BackgroundJob[] = [];
		const { d, terminal, statuses } = deps(root, id, {
			config: config(agent),
			background: (j) => jobs.push(j),
		});
		const running = runThinkSession(d);
		await waitFor(() => terminal.screen().includes("show up here"), 5000, "background notice");
		expect(terminal.screen()).toContain("question 1/2");
		expect(jobs.map((j) => j.label)).toEqual(["agent:agent-sh asking about sync-works-offline"]);
		expect(statuses).toEqual([]);
		writeFileSync(join(root, "go"), "");
		await waitFor(() => terminal.screen().includes("agent asked 1 new"), 15000, "arrival");
		expect(terminal.screen()).toContain("question 1/3");
		terminal.send("s");
		await waitFor(() => terminal.screen().includes("Which record wins"), 3000, "queued next");
		expect(await jobs[0]?.done).toBeNull();
		terminal.send("q");
		const s = await running;
		expect(s.agent).toMatchObject({ mode: "command", status: "background", asked: 1 });
		expect(s.proposals).toBeNull();
		expect(s.changedLines).toEqual([]);
	}, 30000);
});
