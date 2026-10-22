// Subprocess smoke tests: the real entrypoint, real exit codes, real (absent)
// TTY. Keep small; everything else runs in-process via test-helpers.run().

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCli, tempDir } from "./test-helpers.ts";
import { VERSION } from "./version.ts";

const HUMAN = { ROOTS_FORCE_TTY: "1", NODE_ENV: "test" };

describe("roots binary", () => {
	test("--version", async () => {
		const r = await spawnCli(["--version"], tempDir());
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe(VERSION);
	});

	test("full stage-1 flow", async () => {
		const dir = tempDir();
		expect((await spawnCli(["init"], dir)).exitCode).toBe(0);
		expect((await spawnCli(["init"], dir)).exitCode).toBe(5);

		const planted = await spawnCli(["plant", "Sync works offline", "--json"], dir, HUMAN);
		expect(planted.exitCode).toBe(0);
		const { id } = JSON.parse(planted.stdout) as { id: string };

		const shown = await spawnCli(["show", id, "--json"], dir);
		expect(JSON.parse(shown.stdout)).toMatchObject({
			success: true,
			statement: "Sync works offline",
		});

		const listed = await spawnCli(["list"], dir);
		expect(listed.stdout).toContain("sync-works-offline");

		expect((await spawnCli(["mv", id, "offline"], dir)).exitCode).toBe(0);
		const log = await spawnCli(["log", "offline", "--json"], dir);
		expect(JSON.parse(log.stdout).events.map((e: { type: string }) => e.type)).toEqual([
			"plant",
			"mv",
		]);

		// Works from a subdirectory.
		const sub = join(dir, "src", "deep");
		mkdirSync(sub, { recursive: true });
		expect((await spawnCli(["show", "offline"], sub)).exitCode).toBe(0);
	});

	test("plant refuses without a TTY; the override is ignored outside tests", async () => {
		const dir = tempDir();
		await spawnCli(["init"], dir);
		const noTty = await spawnCli(["plant", "x"], dir);
		expect(noTty.exitCode).toBe(4);
		expect(noTty.stderr).toContain("interactive terminal");
		const forcedProd = await spawnCli(["plant", "x"], dir, {
			ROOTS_FORCE_TTY: "1",
			NODE_ENV: "production",
		});
		expect(forcedProd.exitCode).toBe(4);
	});

	test("unknown command exits 2 with a suggestion", async () => {
		const r = await spawnCli(["plnt"], tempDir());
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("luuna-roots plant");
	});

	test("malformed graph lines are skipped, not fatal", async () => {
		const dir = tempDir();
		await spawnCli(["init"], dir);
		writeFileSync(join(dir, ".luuna/roots", "graph.jsonl"), "garbage\n");
		const r = await spawnCli(["list", "--json"], dir);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout).count).toBe(0);
	});

	test("stage-2 commands: think guard, queue, scan", async () => {
		const dir = tempDir();
		await spawnCli(["init"], dir);
		const noTty = await spawnCli(["think"], dir);
		expect(noTty.exitCode).toBe(4);
		expect(noTty.stderr).toContain("interactive terminal");
		const idle = await spawnCli(["think", "--json"], dir, HUMAN);
		expect(JSON.parse(idle.stdout)).toMatchObject({ success: true, session: null });

		const planted = await spawnCli(["plant", "Sync works offline", "--json"], dir, HUMAN);
		const { id } = JSON.parse(planted.stdout) as { id: string };
		const queue = await spawnCli(["queue", "--json"], dir);
		expect(queue.exitCode).toBe(0);
		expect(JSON.parse(queue.stdout).think[0].id).toBe(id);
		const scan = await spawnCli(["scan", "--json"], dir);
		expect(scan.exitCode).toBe(0);
		expect(JSON.parse(scan.stdout)).toMatchObject({ success: true, command: "scan" });
	});

	test("stage-3 commands: tier, ask, context, prime (no TTY needed)", async () => {
		const dir = tempDir();
		await spawnCli(["init"], dir);
		const planted = await spawnCli(["plant", "Sync works offline", "--json"], dir, HUMAN);
		const { id } = JSON.parse(planted.stdout) as { id: string };
		const asked = await spawnCli(["ask", id, "Who wins a conflict?", "--as", "agent:opus"], dir);
		expect(asked.exitCode).toBe(0);
		const asHuman = await spawnCli(["ask", id, "Why?", "--as", "human:jay"], dir);
		expect(asHuman.exitCode).toBe(4);
		const ctx = await spawnCli(["context", id, "--json"], dir);
		expect(JSON.parse(ctx.stdout)).toMatchObject({
			success: true,
			command: "context",
			statement: "Sync works offline",
			limits: { agentQuestionsOpen: 1 },
		});
		expect((await spawnCli(["context", id], dir)).stdout).toContain("Who wins a conflict?");
		expect((await spawnCli(["tier", id, "0"], dir)).exitCode).toBe(0);
		const refused = await spawnCli(["ask", id, "Now?", "--as", "agent:opus"], dir);
		expect(refused.exitCode).toBe(4);
		expect(refused.stderr).toContain("per-idea override");
		const prime = await spawnCli(["prime"], dir);
		expect(prime.exitCode).toBe(0);
		expect(prime.stdout).toContain("sync-works-offline [planted · tier 0]");
	});

	test("stage-4 commands: propose, link, accept/reject, lifecycle, tend guard", async () => {
		const dir = tempDir();
		await spawnCli(["init"], dir);
		const plantId = async (text: string) =>
			(JSON.parse((await spawnCli(["plant", text, "--json"], dir, HUMAN)).stdout) as { id: string })
				.id;
		const a = await plantId("Sync works offline: nobody loses work");
		const b = await plantId("The server is always authoritative");
		const proposed = await spawnCli(
			[
				"propose",
				"edge",
				a,
				b,
				"tension",
				"--reason",
				"x",
				"--cite",
				`${a}:offline: nobody`,
				"--cite",
				`${b}:server`,
				"--as",
				"agent:opus",
				"--json",
			],
			dir,
		);
		expect(proposed.exitCode).toBe(0);
		const { id: p } = JSON.parse(proposed.stdout) as { id: string };
		const badCite = await spawnCli(
			["propose", "compost", b, "--reason", "x", "--cite", `${b}:nope`, "--as", "agent:opus"],
			dir,
		);
		expect(badCite.exitCode).toBe(6);
		expect(badCite.stderr).toContain(`cite quote not found in ${b}`);
		expect((await spawnCli(["tend"], dir)).exitCode).toBe(4);
		expect(JSON.parse((await spawnCli(["tend", "--json"], dir)).stdout).cards).toHaveLength(1);
		const accepted = await spawnCli(["accept", p, "--json"], dir);
		expect(JSON.parse(accepted.stdout).edge).toMatchObject({ rel: "tension", proposal: p });
		const linked = await spawnCli(["link", a, b, "serves", "--json"], dir);
		const { id: e } = JSON.parse(linked.stdout) as { id: string };
		expect((await spawnCli(["unlink", e], dir)).exitCode).toBe(0);
		expect((await spawnCli(["reject", "p-0000"], dir)).exitCode).toBe(3);
		expect((await spawnCli(["commit", a], dir)).exitCode).toBe(5);
		expect((await spawnCli(["compost", a, "--reason", "done"], dir)).exitCode).toBe(0);
		expect((await spawnCli(["status", b, "built"], dir)).exitCode).toBe(5);
	});
	test("stage-5 commands: sprout, note, adopt, reject s-", async () => {
		const dir = tempDir();
		await spawnCli(["init"], dir);
		const idea = JSON.parse(
			(await spawnCli(["plant", "Sync works offline", "--json"], dir, HUMAN)).stdout,
		).id as string;
		const sprouted = await spawnCli(["sprout", "Conflicts get a merge UI", "--json"], dir, {
			ROOTS_AGENT: "agent:opus",
		});
		expect(sprouted.exitCode).toBe(0);
		const { id: s } = JSON.parse(sprouted.stdout) as { id: string };
		writeFileSync(join(dir, "r.md"), "# research\n");
		const noted = await spawnCli(["note", idea, "--file", "r.md", "--as", "agent:opus"], dir);
		expect(noted.exitCode).toBe(0);
		expect(noted.stdout).toContain(".luuna/roots/agent/notes/");
		const noTty = await spawnCli(["adopt", s], dir);
		expect(noTty.exitCode).toBe(4);
		expect(noTty.stderr).toContain("interactive terminal");
		const cancelled = await spawnCli(["adopt", s], dir, { ...HUMAN, EDITOR: "true" });
		expect(cancelled.exitCode).toBe(1);
		expect(cancelled.stderr).toContain("nothing was written");
		const rejected = await spawnCli(["reject", s, "--reason", "no"], dir);
		expect(rejected.exitCode).toBe(0);
		expect(rejected.stdout).toContain("rejected");
	});
});
