import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./register-all.ts";
import { run, tempDir } from "./test-helpers.ts";
import { VERSION } from "./version.ts";

describe("cli runner", () => {
	test("version", async () => {
		const dir = tempDir();
		expect((await run(["--version"], dir)).stdout).toBe(`${VERSION}\n`);
		expect((await run(["-v"], dir)).stdout).toBe(`${VERSION}\n`);
		const json = JSON.parse((await run(["--version", "--json"], dir)).stdout);
		expect(json).toMatchObject({ success: true, command: "version", version: VERSION });
	});

	test("version matches package.json", async () => {
		const pkg = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
			version: string;
		};
		expect(VERSION).toBe(pkg.version);
	});

	test("root help lists every command", async () => {
		const dir = tempDir();
		for (const args of [[], ["--help"], ["-h"], ["help"]]) {
			const r = await run(args, dir);
			expect(r.exitCode).toBe(0);
			for (const c of COMMANDS) expect(r.stdout).toContain(c.usage);
		}
		const json = JSON.parse((await run(["--help", "--json"], dir)).stdout);
		expect(json.commands.map((c: { name: string }) => c.name)).toEqual(COMMANDS.map((c) => c.name));
	});

	test("command help", async () => {
		const dir = tempDir();
		for (const c of COMMANDS) {
			const r = await run([c.name, "--help"], dir);
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain(`Usage: roots ${c.usage}`);
			expect(r.stdout).toContain("--json");
		}
		expect((await run(["help", "list"], dir)).stdout).toContain("--orphans");
	});

	test("unknown command suggests the closest", async () => {
		const dir = tempDir();
		const r = await run(["lst"], dir);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("Did you mean `luuna-roots list`?");
		const j = JSON.parse((await run(["shw", "--json"], dir)).stdout);
		expect(j).toMatchObject({ success: false, command: "shw", code: "usage", suggestion: "show" });
		expect((await run(["zzzzzz"], dir)).stderr).not.toContain("Did you mean");
	});

	test("unknown flag", async () => {
		const r = await run(["list", "--orphan"], tempDir());
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("Did you mean --orphans?");
	});

	test("every command supports --json errors outside a project", async () => {
		const dir = tempDir();
		for (const args of [["show", "x"], ["list"], ["log"], ["mv", "a", "b"]]) {
			const r = await run([...args, "--json"], dir);
			expect(r.exitCode).toBe(3);
			expect(JSON.parse(r.stdout)).toMatchObject({
				success: false,
				command: args[0],
				code: "not_initialized",
			});
		}
	});

	test("color only when stdout is a TTY and NO_COLOR is unset", async () => {
		const { runCli } = await import("./cli.ts");
		let out = "";
		const io = {
			cwd: tempDir(),
			env: { ROOTS_USER: "x" },
			stdout: (t: string) => {
				out += t;
			},
			stderr: () => {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
		};
		await runCli(["--help"], io);
		expect(out).toContain("\x1b[");
		out = "";
		await runCli(["--help"], { ...io, env: { NO_COLOR: "1" } });
		expect(out).not.toContain("\x1b[");
	});
});
