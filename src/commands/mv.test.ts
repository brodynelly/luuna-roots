import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

describe("luuna-roots mv", () => {
	test("renames directory and slug; id stays; logs mv", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works fully offline");
		const paths = rootsPaths(root);
		const hex = id.slice(2);
		const { exitCode, body } = await runJson<{
			id: string;
			oldSlug: string;
			slug: string;
			path: string;
		}>(["mv", hex, "offline-sync"], root, { tty: false });
		expect(exitCode).toBe(0);
		expect(body).toMatchObject({ id, oldSlug: "sync-works-fully-offline", slug: "offline-sync" });
		expect(body.path).toBe(`.luuna/roots/human/${hex}-offline-sync`);
		expect(existsSync(join(paths.human, `${hex}-sync-works-fully-offline`))).toBe(false);
		expect(readFileSync(join(paths.human, `${hex}-offline-sync`, "idea.md"), "utf8")).toBe(
			"Sync works fully offline\n",
		);
		expect(readGraph(paths).nodes[0]).toMatchObject({ id, slug: "offline-sync" });
		const ev = readEvents(paths).filter((e) => e.type === "mv");
		expect(ev).toEqual([
			expect.objectContaining({ by: "human:test-human", node: id, newSlug: "offline-sync" }),
		]);
		expect((await run(["show", "offline-sync"], root)).exitCode).toBe(0);
	});

	test("validation: bad slug, clash, same name, unknown node", async () => {
		const root = await initProject();
		const a = await plant(root, "Alpha", ["--slug", "alpha"]);
		await plant(root, "Beta", ["--slug", "beta"]);
		const bad = await run(["mv", a, "Not Kebab"], root);
		expect(bad.exitCode).toBe(EXIT.usage);
		expect(bad.stderr).toContain('try "not-kebab"');
		expect((await run(["mv", a, "r-abcd"], root)).exitCode).toBe(EXIT.usage);
		expect((await run(["mv", a, "beta"], root)).exitCode).toBe(EXIT.conflict);
		expect((await run(["mv", a, "alpha"], root)).exitCode).toBe(EXIT.usage);
		expect((await run(["mv", "nope", "gamma"], root)).exitCode).toBe(EXIT.notFound);
		expect((await run(["mv", a], root)).exitCode).toBe(EXIT.usage);
		expect(readGraph(rootsPaths(root)).nodes.map((n) => n.slug)).toEqual(["alpha", "beta"]);
	});

	test("target directory already on disk: conflict, nothing renamed", async () => {
		const root = await initProject();
		const a = await plant(root, "Alpha", ["--slug", "alpha"]);
		const paths = rootsPaths(root);
		const hex = a.slice(2);
		mkdirSync(join(paths.human, `${hex}-gamma`));
		expect((await run(["mv", a, "gamma"], root)).exitCode).toBe(EXIT.conflict);
		expect(existsSync(join(paths.human, `${hex}-alpha`))).toBe(true);
		expect(readGraph(paths).nodes[0]?.slug).toBe("alpha");
	});

	test("missing directory: slug updated with a warning", async () => {
		const root = await initProject();
		const a = await plant(root, "Alpha", ["--slug", "alpha"]);
		rmSync(join(rootsPaths(root).human, `${a.slice(2)}-alpha`), { recursive: true });
		const r = await run(["mv", a, "gamma"], root);
		expect(r.exitCode).toBe(0);
		expect(r.stderr).toContain("no directory found");
	});

	test("requires a human name", async () => {
		const root = await initProject();
		const a = await plant(root, "Alpha");
		const r = await run(["mv", a, "gamma"], root, { env: { ROOTS_USER: undefined, HOME: root } });
		expect(r.exitCode).toBe(EXIT.guard);
	});
});
