import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeColors } from "./color.ts";
import { defaultConfig, type RootsConfig } from "./config.ts";
import { appendEvent, makeEvent, readEvents } from "./events.ts";
import { type FlowDeps, runFlow } from "./flow-session.ts";
import { readHeadings } from "./headings.ts";
import { rootsPaths } from "./paths.ts";
import { CLI_ENTRY, fakeTerminal, initProject, plant, run, waitFor } from "./test-helpers.ts";
import type { SessionSummary } from "./think-session.ts";

const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" };
const BY = "human:test-human";

function agentScript(dir: string, body: string): string {
	const file = join(dir, "agent.sh");
	writeFileSync(file, `#!/bin/sh\nroots() { bun "${CLI_ENTRY}" "$@"; }\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

function config(command: string | null): RootsConfig {
	return { ...defaultConfig("warren"), agent: { command, timeoutSeconds: 20 } };
}

async function setup(command: (root: string, a: string, b: string) => string | null) {
	const root = await initProject();
	const a = await plant(root, "Every action has a named principal");
	const b = await plant(root, "No long-lived secret enters a sandbox");
	const paths = rootsPaths(root);
	const terminal = fakeTerminal(72, 30);
	const thought: string[] = [];
	const deps: FlowDeps = {
		paths,
		config: config(command(root, a, b)),
		by: BY,
		terminal,
		colors: makeColors(false),
		env: ENV,
		refreshMs: 20,
		tally: (s) => `${s.tally.answered} answered`,
		// A stand-in think session: logs what a real one would.
		think: async (id) => {
			thought.push(id);
			await appendEvent(paths, makeEvent("session.start", BY, { node: id, session: "ss-0001" }));
			await appendEvent(
				paths,
				makeEvent("session.end", BY, { node: id, session: "ss-0001", answered: 2 }),
			);
			return {
				session: "ss-0001",
				node: id,
				tally: { answered: 2, dismissed: 0, snoozed: 0, skipped: 0, unasked: 0 },
				changedLines: [],
			} as unknown as SessionSummary;
		},
		tend: async () => "tended 1",
		plant: async () => {
			const r = await run(["plant", "Grants are narrowed and expire", "--json"], root);
			return (JSON.parse(r.stdout) as { id: string }).id;
		},
	};
	return { root, a, b, paths, terminal, deps, thought };
}

describe("runFlow", () => {
	test("card → think → heading arrives → dismiss → plant → quit", async () => {
		const { a, b, paths, terminal, deps, thought } = await setup((root, a, b) =>
			agentScript(
				root,
				`luuna-roots heading "Converging on ${a}." --cite "${a}:named principal" --next ${b}`,
			),
		);
		const running = runFlow(deps);
		await waitFor(() => terminal.screen().includes("luuna-roots flow ── warren"), 3000, "card");
		expect(terminal.screen()).toContain("nothing yet");
		expect(terminal.screen()).toContain("[enter] think:");
		terminal.send("\r");
		await waitFor(() => thought.length === 1, 3000, "think");
		await waitFor(() => terminal.screen().includes(`Converging on ${a}.`), 15000, "heading");
		const screen = terminal.screen();
		expect(screen).toContain("── heading ── [agent]");
		expect(screen).toContain("done · 2 answered");
		expect(screen).toContain(`[enter] think: ${b}`);
		expect(screen).toContain("← heading");
		expect(screen).toMatch(/r-[0-9a-f]{4} [a-z-]+ +2 answered/);
		terminal.send("x");
		await waitFor(() => terminal.screen().includes("heading dismissed"), 3000, "dismiss");
		expect(readHeadings(paths)[0]?.status).toBe("dismissed");
		terminal.send("p");
		await waitFor(() => terminal.screen().includes("just planted"), 5000, "plant");
		terminal.send("q");
		const s = await running;
		expect(s.trail.entries.map((e) => e.id)).toEqual(thought);
		expect(s.trail.planted).toHaveLength(1);
		const types = readEvents(paths).map((e) => e.type);
		expect(types).toContain("flow.start");
		expect(types[types.length - 1]).toBe("flow.end");
		expect(types).toContain("heading.dismiss");
		await s.pending;
	}, 30000);

	test("enter reviews the inbox first; a failing agent shows on the card", async () => {
		const { root, terminal, deps } = await setup((root) => agentScript(root, "exit 3"));
		await run(["sprout", "Runs record their agent", "--as", "agent:opus"], root);
		let tended = 0;
		const running = runFlow({
			...deps,
			tend: async () => {
				tended++;
				return "tended 1";
			},
		});
		await waitFor(() => terminal.screen().includes("[enter] review inbox (1)"), 3000, "inbox");
		expect(terminal.screen()).toContain("inbox 1");
		terminal.send("\r");
		await waitFor(() => tended === 1, 3000, "tend");
		await waitFor(() => terminal.screen().includes("tended 1"), 3000, "tend notice");
		terminal.send("n");
		await waitFor(() => terminal.screen().includes("exited with code 3"), 15000, "agent failure");
		terminal.send("q");
		const s = await running;
		await s.pending;
		expect(s.problems[0]).toContain("exited with code 3");
	}, 30000);

	test("flow <id> starts by thinking it; no agent means no heading section", async () => {
		const { b, terminal, deps, thought } = await setup(() => null);
		const running = runFlow({ ...deps, start: b });
		await waitFor(() => thought.length === 1, 3000, "start think");
		expect(thought).toEqual([b]);
		await waitFor(() => terminal.screen().includes("done · 2 answered"), 3000, "card");
		expect(terminal.screen()).not.toContain("heading");
		terminal.send("\x03");
		const s = await running;
		expect(s.running).toEqual([]);
	});
});
