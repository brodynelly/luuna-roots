import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_INSTRUCTION,
	agentActorFor,
	agentEnv,
	agentPrompt,
	runAgentCommand,
} from "./agent-runner.ts";
import { loadConfig } from "./config.ts";
import { buildContext } from "./context.ts";
import { findNode, readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { scanNodeDirs } from "./prose.ts";
import { initProject, plant, tempDir } from "./test-helpers.ts";

function script(dir: string, body: string): string {
	const file = join(dir, `agent-${Math.random().toString(16).slice(2)}.sh`);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

const ENV = { PATH: process.env.PATH ?? "" };

describe("agent runner", () => {
	test("agentActorFor reads --model, else the program name", () => {
		expect(agentActorFor("claude -p --model claude-opus-5-5")).toBe("agent:claude-opus-5-5");
		expect(agentActorFor("claude -p --model=opus")).toBe("agent:opus");
		expect(agentActorFor("/usr/local/bin/codex exec")).toBe("agent:codex");
	});

	test("agentEnv sets identity + session and drops the human's name", () => {
		const env = agentEnv(
			{ PATH: "/bin", ROOTS_USER: "jay", ROOTS_FORCE_TTY: "1", X: undefined },
			{ actor: "agent:opus", session: "ss-1", node: "r-1" },
		);
		expect(env).toEqual({
			PATH: "/bin",
			ROOTS_AGENT: "agent:opus",
			ROOTS_SESSION: "ss-1",
			ROOTS_NODE: "r-1",
		});
	});

	test("prompt = fixed instruction (filled) + Markdown packet", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const paths = rootsPaths(root);
		const graph = readGraph(paths);
		const node = findNode(graph, id);
		if (!node) throw new Error("no node");
		const packet = buildContext(
			{ paths, graph, dirs: scanNodeDirs(paths) },
			loadConfig(paths),
			node,
			{
				repo: false,
			},
		);
		const prompt = agentPrompt(packet, { actor: "agent:opus", asks: 2 });
		expect(AGENT_INSTRUCTION).toContain("{{asks}}");
		expect(prompt).toContain(`luuna-roots ask ${id} "<your question>" --as agent:opus`);
		expect(prompt).toContain("ask up to 2 questions");
		expect(prompt).toContain("at most 280 characters");
		expect(prompt).not.toContain("{{");
		expect(prompt).toContain(`# luuna-roots context: ${id} sync-works-offline`);
	});

	test("ok: stdin delivered, env passed, cwd is the project", async () => {
		const dir = tempDir();
		const agent = script(
			dir,
			'cat > got-stdin.txt\necho "$ROOTS_AGENT $ROOTS_SESSION" > got-env.txt',
		);
		const r = await runAgentCommand({
			command: agent,
			cwd: dir,
			input: "hello agent",
			env: { ...ENV, ROOTS_AGENT: "agent:x", ROOTS_SESSION: "ss-1" },
			timeoutMs: 5000,
		});
		expect(r).toMatchObject({ status: "ok", exitCode: 0, error: null });
		expect(readFileSync(join(dir, "got-stdin.txt"), "utf8")).toBe("hello agent");
		expect(readFileSync(join(dir, "got-env.txt"), "utf8")).toBe("agent:x ss-1\n");
	});

	test("non-zero exit and missing commands fail softly with an output tail", async () => {
		const dir = tempDir();
		const bad = script(dir, "echo boom >&2\nexit 3");
		const r = await runAgentCommand({
			command: bad,
			cwd: dir,
			input: "",
			env: ENV,
			timeoutMs: 5000,
		});
		expect(r).toMatchObject({ status: "failed", exitCode: 3, error: "exited with code 3" });
		expect(r.output).toContain("boom");
		const missing = await runAgentCommand({
			command: "definitely-not-a-command-xyz",
			cwd: dir,
			input: "",
			env: ENV,
			timeoutMs: 5000,
		});
		expect(missing.status).toBe("failed");
		expect(missing.exitCode).toBe(127);
	});

	test("timeout kills the whole process group", async () => {
		const dir = tempDir();
		const slow = script(dir, `sleep 30 &\nsleep 30\necho late > late.txt`);
		const started = Date.now();
		const r = await runAgentCommand({
			command: slow,
			cwd: dir,
			input: "",
			env: ENV,
			timeoutMs: 200,
			killGraceMs: 200,
		});
		expect(r.status).toBe("timeout");
		expect(r.error).toBe("timed out after 200ms");
		expect(Date.now() - started).toBeLessThan(3000);
	});
});
