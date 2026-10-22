// Tier 2: at the end of a think session, agent.command gets the changed
// lines and the other ideas, and may `luuna-roots propose edge --mention`. The
// agent is a real shell script calling the real CLI.

import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeColors } from "./color.ts";
import { defaultConfig, type RootsConfig } from "./config.ts";
import { findNode, readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { readProposals } from "./proposals.ts";
import { readNodeProse } from "./prose.ts";
import { proposalCards } from "./tend.ts";
import { CLI_ENTRY, fakeTerminal, initProject, plant, waitFor } from "./test-helpers.ts";
import { runThinkSession, type ThinkDeps } from "./think-session.ts";

const WATCH = { debounceMs: 20, pollMs: 50 };
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" };

/** Proposes only when given the session-end instruction; logs every prompt. */
function agentScript(dir: string, other: string): string {
	const file = join(dir, "agent.sh");
	const body = [
		"#!/bin/sh",
		`roots() { bun "${CLI_ENTRY}" "$@"; }`,
		`prompt=$(cat); echo "$prompt" >> "${join(dir, "prompts.log")}"`,
		'case "$prompt" in *"propose ONE edge"*) ;; *) exit 0 ;; esac',
		`luuna-roots propose edge "$ROOTS_NODE" ${other} tension --mention --reason "edits vs server truth" --cite "$ROOTS_NODE:pulls against the server idea"`,
	];
	writeFileSync(file, `${body.join("\n")}\n`);
	chmodSync(file, 0o755);
	return file;
}

function config(command: string, tier: RootsConfig["tier"]): RootsConfig {
	return { ...defaultConfig("p"), tier, agent: { command, timeoutSeconds: 20 } };
}

async function session(root: string, id: string, cfg: RootsConfig, line: string) {
	const paths = rootsPaths(root);
	const node = findNode(readGraph(paths), id);
	if (!node) throw new Error("no node");
	const terminal = fakeTerminal(70);
	const d: ThinkDeps = {
		paths,
		config: cfg,
		node,
		by: "human:test-human",
		terminal,
		colors: makeColors(false),
		editorHint: "",
		watch: WATCH,
		env: ENV,
	};
	const running = runThinkSession(d);
	await waitFor(() => terminal.frames.length > 0, 15000, "session screen");
	appendFileSync(readNodeProse(paths, node).path ?? "", `\n${line}\n`);
	await waitFor(() => terminal.screen().includes("answered"), 5000, "save");
	terminal.send("q");
	return running;
}

describe("session-end agent proposals (tier 2)", () => {
	test("the agent links a fuzzy mention; it shares a card with the deterministic one", async () => {
		const root = await initProject();
		const a = await plant(root, "Sync works offline");
		const b = await plant(root, "The server is always authoritative");
		const agent = agentScript(root, b);
		const s = await session(
			root,
			a,
			config(agent, 2),
			`This pulls against the server idea (${b}).`,
		);
		expect(s.mentions?.result.filed).toHaveLength(1);
		expect(s.proposals).toMatchObject({ actor: "agent:agent-sh", status: "ok" });
		expect(s.proposals?.filed).toHaveLength(1);
		const rows = readProposals(rootsPaths(root));
		expect(rows.map((p) => p.by).sort()).toEqual(["agent:agent-sh", "roots:mention"]);
		const agentP = rows.find((p) => p.by === "agent:agent-sh");
		expect(agentP?.cites).toEqual([
			{ node: a, quote: "pulls against the server idea" },
			{ node: b, quote: "The server is always authoritative" },
		]);
		const cards = proposalCards(rows, (id) => ({ id, slug: id }));
		expect(cards).toHaveLength(1);
		const prompts = readFileSync(join(root, "prompts.log"), "utf8");
		expect(prompts).toContain("## Changed lines (this session)");
		expect(prompts).toContain(`- ${b} `);
		expect(prompts).toContain(`luuna-roots propose edge ${a} <other-id>`);
	}, 40000);

	test("below tier 2 the session-end run is skipped", async () => {
		const root = await initProject();
		const a = await plant(root, "Sync works offline");
		const b = await plant(root, "The server is always authoritative");
		const s = await session(root, a, config(agentScript(root, b), 1), "Plain words.");
		expect(s.proposals).toBeNull();
		const log = join(root, "prompts.log");
		const prompts = existsSync(log) ? readFileSync(log, "utf8") : "";
		expect(prompts).not.toContain("propose ONE edge");
	}, 30000);
});
