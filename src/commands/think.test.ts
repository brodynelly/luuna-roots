import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { rootsPaths } from "../paths.ts";
import {
	CLI_ENTRY,
	fakeTerminal,
	initProject,
	plant,
	run,
	runJson,
	waitFor,
} from "../test-helpers.ts";

describe("luuna-roots think", () => {
	test("refuses without a TTY (agents cannot run it)", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const r = await runJson(["think", id], root, { tty: false, terminal: fakeTerminal() });
		expect(r.exitCode).toBe(EXIT.guard);
		expect(r.body).toMatchObject({ success: false, code: "guard" });
		expect(readEvents(rootsPaths(root)).some((e) => e.type === "session.start")).toBe(false);
	});

	test("no id and nothing queued: friendly no-op", async () => {
		const root = await initProject();
		const r = await runJson(["think"], root, { terminal: fakeTerminal() });
		expect(r.exitCode).toBe(0);
		expect(r.body).toMatchObject({ success: true, session: null, reason: "nothing-queued" });
		const h = await run(["think"], root, { terminal: fakeTerminal() });
		expect(h.stdout).toContain("Nothing needs thinking right now.");
	});

	test("full session via the CLI: picks from the queue, prints the path, summarizes", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const term = fakeTerminal(50);
		const running = runJson<Record<string, unknown>>(["think"], root, { terminal: term });
		await waitFor(() => term.screen().includes("question 1/2"), 3000, "screen");
		const screen = term.screen();
		expect(screen).toContain(`${id}  sync-works-offline`);
		expect(screen).toContain("planted");
		expect(screen).toContain("Open");
		expect(screen).toContain("idea.md");
		const hex = id.slice(2);
		const file = join(root, ".luuna/roots/human", `${hex}-sync-works-offline`, "idea.md");
		writeFileSync(file, "Sync works offline\n\nDone when nothing is lost.\n");
		await waitFor(() => term.screen().includes("question 2/2"), 3000, "advance");
		term.send("q");
		const { exitCode, body } = await running;
		expect(exitCode).toBe(0);
		expect(body).toMatchObject({
			success: true,
			command: "think",
			node: id,
			reason: "quit",
			tally: { answered: 1, unasked: 1 },
			statusChange: { from: "planted", to: "shaping" },
			path: `.luuna/roots/human/${hex}-sync-works-offline/idea.md`,
			split: { mux: null, ok: false },
		});
		expect(term.stopped).toBe(true);
	});

	test("human summary and --no-split", async () => {
		const root = await initProject();
		const id = await plant(root, "Offline and fast, done when nothing is lost, not realtime");
		const term = fakeTerminal();
		const running = run(["think", id, "--no-split"], root, { terminal: term });
		await waitFor(() => term.screen().includes("question 1/1"));
		expect(term.screen()).toContain("[too-big]");
		term.send("d");
		const r = await running;
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("✓ session ss-");
		expect(r.stdout).toContain("1 dismissed");
		expect(r.stdout).toContain("status planted → shaping");
	});

	test("composted ideas and sprouts are refused", async () => {
		const root = await initProject();
		const r = await runJson(["think", "nope"], root, { terminal: fakeTerminal() });
		expect(r.exitCode).toBe(EXIT.notFound);
	});

	test("agent.command from config.yaml: status line, agent questions, summary", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const agent = join(root, "agent.sh");
		writeFileSync(
			agent,
			`#!/bin/sh\nbun "${CLI_ENTRY}" ask "$ROOTS_NODE" "Who wins a conflict?" >/dev/null\nexit 0\n`,
		);
		chmodSync(agent, 0o755);
		const cfg = join(root, ".luuna/roots", "config.yaml");
		const text = readFileSync(cfg, "utf8").replace(/^ {2}# command: .*$/m, `  command: "${agent}"`);
		writeFileSync(cfg, text);
		const term = fakeTerminal();
		const running = run(["think", id, "--no-split"], root, { terminal: term });
		await waitFor(() => term.screen().includes("question 1/3"), 15000);
		expect(term.screen()).toContain("[agent]");
		term.send("q");
		const r = await running;
		expect(r.exitCode).toBe(0);
		expect(r.stderr).toContain("asking agent:agent-sh for questions about sync-works-offline");
		expect(r.stdout).toContain("agent:agent-sh asked 1 question");
	}, 30000);
});
