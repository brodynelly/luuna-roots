import { describe, expect, test } from "bun:test";
import { EXIT } from "../errors.ts";
import { fakeTerminal, initProject, plant, run, waitFor } from "../test-helpers.ts";

describe("luuna-roots flow", () => {
	test("needs a TTY", async () => {
		const root = await initProject();
		expect((await run(["flow"], root, { tty: false })).exitCode).toBe(EXIT.guard);
	});

	test("shows the card, quits on q, prints the trail and the next step", async () => {
		const root = await initProject();
		const id = await plant(root, "Every action has a named principal");
		const terminal = fakeTerminal(72, 24);
		const running = run(["flow"], root, { terminal });
		await waitFor(() => terminal.screen().includes("luuna-roots flow"), 3000, "card");
		expect(terminal.screen()).toContain(`[enter] think: ${id}`);
		terminal.send("q");
		const r = await running;
		expect(r.exitCode).toBe(0);
		expect(r.stdout + r.stderr).toMatch(/flow fl-[0-9a-f]{4} ended/);
		expect(r.stdout + r.stderr).toContain(`next: luuna-roots think ${id}`);
	});

	test("an unknown start id fails before the card opens", async () => {
		const root = await initProject();
		const terminal = fakeTerminal(72, 24);
		const r = await run(["flow", "r-dead"], root, { terminal });
		expect(r.exitCode).not.toBe(0);
		expect(terminal.started).toBe(false);
	});
});
