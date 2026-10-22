import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, type RootsConfig } from "./config.ts";
import { appendEvent, makeEvent, readEvents } from "./events.ts";
import { buildTrail } from "./flow.ts";
import { readGraph } from "./graph.ts";
import { headingEnabled, runHeadingPhase } from "./heading-run.ts";
import { dismissHeading, readHeadings } from "./headings.ts";
import { rootsPaths } from "./paths.ts";
import { readQuestions } from "./questions.ts";
import { CLI_ENTRY, initProject, plant, run } from "./test-helpers.ts";

const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" };

function agentScript(dir: string, body: string): string {
	const file = join(dir, "agent.sh");
	writeFileSync(file, `#!/bin/sh\nroots() { bun "${CLI_ENTRY}" "$@"; }\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

function config(command: string | null, over: Partial<RootsConfig> = {}): RootsConfig {
	return { ...defaultConfig("p"), agent: { command, timeoutSeconds: 20 }, ...over };
}

async function setup() {
	const root = await initProject();
	const a = await plant(root, "Every action has a named principal");
	const b = await plant(root, "No long-lived secret enters a sandbox");
	const paths = rootsPaths(root);
	await appendEvent(paths, makeEvent("flow.start", "human:test-human", { flow: "fl-0001" }));
	await appendEvent(
		paths,
		makeEvent("session.end", "human:test-human", { node: a, session: "ss-1", answered: 2 }),
	);
	const trail = () =>
		buildTrail(readEvents(paths), readGraph(paths), readQuestions(paths), "fl-0001", new Date());
	return { root, a, b, paths, trail };
}

describe("heading run", () => {
	test("the agent gets the trail and files one cited heading", async () => {
		const { root, a, b, paths, trail } = await setup();
		const agent = agentScript(
			root,
			[
				"cat > prompt.txt",
				`luuna-roots heading "Converging on ${a}; unsaid: how secrets stay out." --cite "${a}:named principal" --next ${b}`,
			].join("\n"),
		);
		const r = await runHeadingPhase({
			paths,
			config: config(agent),
			flow: "fl-0001",
			trail: trail(),
			env: ENV,
		});
		expect(r?.run.status).toBe("ok");
		expect(r?.heading).toMatchObject({ next: b, by: "agent:agent-sh", flow: "fl-0001" });
		const prompt = readFileSync(join(root, "prompt.txt"), "utf8");
		expect(prompt).toContain("flow\nsession fl-0001");
		expect(prompt).toContain(`(planted): 2 answered, 0 open  ← just now`);
		expect(prompt).toContain("Every action has a named principal\n```");
		expect(prompt).toContain(`- ${b} no-long-lived-secret (planted): "No long-lived`);
		expect(prompt).toContain("--as agent:agent-sh");
	}, 30000);

	test("dismissed headings and the current one are in the packet", async () => {
		const { root, a, paths, trail } = await setup();
		await run(
			["heading", "Old read.", "--flow", "fl-0001", "--cite", `${a}:Every`, "--as", "agent:x"],
			root,
		);
		const [old] = readHeadings(paths);
		await dismissHeading(paths, old?.id ?? "", "human:test-human");
		await run(
			["heading", "Newer read.", "--flow", "fl-0001", "--cite", `${a}:Every`, "--as", "agent:x"],
			root,
		);
		const agent = agentScript(root, "cat > prompt.txt");
		const r = await runHeadingPhase({
			paths,
			config: config(agent),
			flow: "fl-0001",
			trail: trail(),
			env: ENV,
		});
		expect(r?.heading).toBeNull();
		const prompt = readFileSync(join(root, "prompt.txt"), "utf8");
		expect(prompt).toContain("## Current heading\n\nNewer read.");
		expect(prompt).toContain("## Dismissed headings\n\n- Old read.");
	}, 30000);

	test("skipped when off: no command, tier 0, flow.heading false, empty trail", async () => {
		const { paths, trail } = await setup();
		expect(headingEnabled(config(null))).toBe(false);
		expect(headingEnabled(config("x", { tier: 0 }))).toBe(false);
		expect(headingEnabled(config("x", { flow: { heading: false } }))).toBe(false);
		expect(headingEnabled(config("x"))).toBe(true);
		const empty = { ...trail(), entries: [] };
		expect(
			await runHeadingPhase({
				paths,
				config: config("true"),
				flow: "fl-0001",
				trail: empty,
				env: ENV,
			}),
		).toBeNull();
	});
});
