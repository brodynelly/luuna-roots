import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../config.ts";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { rootsPaths } from "../paths.ts";
import { run, runJson, tempDir } from "../test-helpers.ts";
import { ensureGitattributes, GITATTRIBUTES_LINE } from "./init.ts";

describe("luuna-roots init", () => {
	test("creates the .luuna/roots layout", async () => {
		const dir = tempDir();
		const { exitCode, body } = await runJson<{ created: string[]; gitattributes: string }>(
			["init"],
			dir,
		);
		expect(exitCode).toBe(0);
		expect(body.gitattributes).toBe("added");
		const p = rootsPaths(dir);
		for (const f of [p.config, p.graph, p.proposals, p.questions, p.events, p.gitignore]) {
			expect(existsSync(f)).toBe(true);
		}
		for (const d of [p.human, p.sprouts, p.notes]) expect(existsSync(d)).toBe(true);
		expect(readFileSync(p.gitignore, "utf8")).toContain("*.lock");
		expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toBe(`${GITATTRIBUTES_LINE}\n`);
		expect(loadConfig(p)).toEqual(defaultConfig(dir.split("/").pop() ?? ""));
		expect(body.created).toContain(".luuna/roots/config.yaml");
		const events = readEvents(p);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "init", by: "human:test-human" });
	});

	test("second init is a conflict and changes nothing", async () => {
		const dir = tempDir();
		await run(["init"], dir);
		const before = readFileSync(rootsPaths(dir).events, "utf8");
		const r = await runJson<{ success: boolean; code: string }>(["init"], dir);
		expect(r.exitCode).toBe(EXIT.conflict);
		expect(r.body).toMatchObject({ success: false, command: "init", code: "conflict" });
		expect(readFileSync(rootsPaths(dir).events, "utf8")).toBe(before);
	});

	test("init without a resolvable human logs by `roots`", async () => {
		const dir = tempDir();
		await run(["init"], dir, { env: { ROOTS_USER: undefined, HOME: dir } });
		expect(readEvents(rootsPaths(dir))[0]?.by).toBe("roots");
	});

	test("gitattributes: appended idempotently, respecting existing content", () => {
		const dir = tempDir();
		const file = join(dir, ".gitattributes");
		writeFileSync(file, "*.png binary");
		expect(ensureGitattributes(dir)).toBe(true);
		expect(ensureGitattributes(dir)).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(`*.png binary\n${GITATTRIBUTES_LINE}\n`);
	});

	test("human output", async () => {
		const r = await run(["init"], tempDir());
		expect(r.stdout).toContain("initialized .luuna/roots/");
		expect(r.stdout).toContain("merge=union");
		const q = await run(["init", "-q"], tempDir());
		expect(q.stdout).toBe("");
	});
});
