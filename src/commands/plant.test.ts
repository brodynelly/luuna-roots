import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { contentHash } from "../prose.ts";
import { fakeEditor, initProject, plant, run, runJson, tempDir } from "../test-helpers.ts";

interface PlantBody {
	success: boolean;
	id: string;
	slug: string;
	status: string;
	author: string;
	path: string;
	statement: string;
	code?: string;
}

describe("luuna-roots plant", () => {
	test("with a statement: writes idea.md, node, event", async () => {
		const root = await initProject();
		const { exitCode, body } = await runJson<PlantBody>(
			["plant", "Sync works fully offline, and nobody loses work."],
			root,
		);
		expect(exitCode).toBe(0);
		expect(body.id).toMatch(/^r-[0-9a-f]{4}$/);
		expect(body).toMatchObject({
			slug: "sync-works-fully-offline",
			status: "planted",
			author: "human:test-human",
			statement: "Sync works fully offline, and nobody loses work.",
		});
		const paths = rootsPaths(root);
		const text = readFileSync(join(root, body.path), "utf8");
		expect(text).toBe("Sync works fully offline, and nobody loses work.\n");
		expect(body.path).toBe(`.luuna/roots/human/${body.id.slice(2)}-sync-works-fully-offline/idea.md`);
		const node = readGraph(paths).nodes[0];
		expect(node).toMatchObject({ id: body.id, kind: "idea", author: "human:test-human" });
		expect(node && "statement" in node).toBe(false); // never cached
		const ev = readEvents(paths).find((e) => e.type === "plant");
		expect(ev).toMatchObject({ node: body.id, by: "human:test-human", hash: contentHash(text) });
	});

	test("multiple positionals are joined; --slug overrides", async () => {
		const root = await initProject();
		const { body } = await runJson<PlantBody>(["plant", "Local", "first", "--slug", "lf"], root);
		expect(body.slug).toBe("lf");
		expect(body.statement).toBe("Local first");
	});

	test("duplicate slugs get a counter; explicit clash is a conflict", async () => {
		const root = await initProject();
		await plant(root, "Offline sync");
		const { body } = await runJson<PlantBody>(["plant", "Offline sync!"], root);
		expect(body.slug).toBe("offline-sync-2");
		const clash = await runJson<PlantBody>(["plant", "x", "--slug", "offline-sync"], root);
		expect(clash.exitCode).toBe(EXIT.conflict);
		const bad = await runJson<PlantBody>(["plant", "x", "--slug", "Bad Slug"], root);
		expect(bad.exitCode).toBe(EXIT.usage);
		expect(readGraph(rootsPaths(root)).nodes).toHaveLength(2);
	});

	test("ids are unique across many plants", async () => {
		const root = await initProject();
		const ids = new Set<string>();
		for (let i = 0; i < 15; i++) ids.add(await plant(root, `Idea number ${i}`));
		expect(ids.size).toBe(15);
		expect(readdirSync(rootsPaths(root).human)).toHaveLength(15);
	});

	test("refuses without a TTY (guard) and writes nothing", async () => {
		const root = await initProject();
		const r = await runJson<PlantBody>(["plant", "x"], root, { tty: false });
		expect(r.exitCode).toBe(EXIT.guard);
		expect(r.body.code).toBe("guard");
		expect(readGraph(rootsPaths(root)).nodes).toHaveLength(0);
	});

	test("refuses without a human name", async () => {
		const root = await initProject();
		const r = await run(["plant", "x"], root, { env: { ROOTS_USER: undefined, HOME: root } });
		expect(r.exitCode).toBe(EXIT.guard);
		expect(r.stderr).toContain("ROOTS_USER");
	});

	test("refuses outside a roots project", async () => {
		const r = await runJson<PlantBody>(["plant", "x"], tempDir());
		expect(r.exitCode).toBe(EXIT.notFound);
		expect(r.body.code).toBe("not_initialized");
	});

	test("blank statement is a usage error", async () => {
		const root = await initProject();
		expect((await run(["plant", "  "], root)).exitCode).toBe(EXIT.usage);
	});

	test("no argument: opens $EDITOR and keeps the prose exactly", async () => {
		const root = await initProject();
		const prose = "\nLocal-first by default.\n\nDone means it works on a plane.\n";
		const editor = fakeEditor(root, prose);
		const { exitCode, body } = await runJson<PlantBody>(["plant"], root, {
			env: { EDITOR: editor },
		});
		expect(exitCode).toBe(0);
		expect(body.statement).toBe("Local-first by default.");
		expect(body.slug).toBe("local-first-default");
		expect(readFileSync(join(root, body.path), "utf8")).toBe(prose);
	});

	test("VISUAL wins over EDITOR", async () => {
		const root = await initProject();
		const env = {
			VISUAL: fakeEditor(root, "From visual"),
			EDITOR: fakeEditor(root, "From editor"),
		};
		const { body } = await runJson<PlantBody>(["plant"], root, { env });
		expect(body.statement).toBe("From visual");
	});

	test("empty editor save cancels", async () => {
		const root = await initProject();
		const r = await runJson<PlantBody>(["plant"], root, {
			env: { EDITOR: fakeEditor(root, "  \n") },
		});
		expect(r.exitCode).toBe(EXIT.error);
		expect(r.body.code).toBe("cancelled");
		expect(readGraph(rootsPaths(root)).nodes).toHaveLength(0);
		expect(readdirSync(rootsPaths(root).human)).toHaveLength(0);
	});

	test("failing editor aborts", async () => {
		const root = await initProject();
		const r = await run(["plant"], root, { env: { EDITOR: "false" } });
		expect(r.exitCode).toBe(EXIT.error);
		expect(r.stderr).toContain("exited with status");
		expect(existsSync(join(rootsPaths(root).human))).toBe(true);
		expect(readGraph(rootsPaths(root)).nodes).toHaveLength(0);
	});
});
