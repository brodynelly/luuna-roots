import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NotInitializedError } from "./errors.ts";
import { readEvents } from "./events.ts";
import { readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { initProject, plant, tempDir } from "./test-helpers.ts";
import { DIR_RENAME_ACTOR, openWorkspace } from "./workspace.ts";

describe("openWorkspace", () => {
	test("throws when not initialized", async () => {
		await expect(openWorkspace(tempDir())).rejects.toBeInstanceOf(NotInitializedError);
	});

	test("finds .luuna/roots/ from a subdirectory", async () => {
		const root = await initProject();
		const sub = join(root, "a", "b");
		mkdirSync(sub, { recursive: true });
		const ws = await openWorkspace(sub);
		expect(ws.paths.root).toBe(rootsPaths(root).root);
	});

	test("a manual directory rename fixes up the slug and logs an mv event", async () => {
		const root = await initProject();
		const id = await plant(root, "Offline sync");
		const paths = rootsPaths(root);
		const hex = id.slice(2);
		renameSync(join(paths.human, `${hex}-offline-sync`), join(paths.human, `${hex}-sync-offline`));
		const ws = await openWorkspace(root);
		expect(ws.fixes).toEqual([
			{ id, oldSlug: "offline-sync", newSlug: "sync-offline", dir: `${hex}-sync-offline` },
		]);
		expect(readGraph(paths).nodes[0]?.slug).toBe("sync-offline");
		const mv = readEvents(paths).filter((e) => e.type === "mv");
		expect(mv).toHaveLength(1);
		expect(mv[0]).toMatchObject({ by: DIR_RENAME_ACTOR, node: id, newSlug: "sync-offline" });
		// Idempotent: a second open changes nothing.
		expect((await openWorkspace(root)).fixes).toEqual([]);
	});

	test("no fix-up for invalid or clashing directory slugs", async () => {
		const root = await initProject();
		const a = await plant(root, "Alpha idea");
		await plant(root, "Beta idea");
		const paths = rootsPaths(root);
		const hex = a.slice(2);
		renameSync(join(paths.human, `${hex}-alpha-idea`), join(paths.human, `${hex}-Bad Name`));
		expect((await openWorkspace(root)).fixes).toEqual([]);
		renameSync(join(paths.human, `${hex}-Bad Name`), join(paths.human, `${hex}-beta-idea`));
		expect((await openWorkspace(root)).fixes).toEqual([]);
		// Two dirs for the same hex: ambiguous, leave alone.
		renameSync(join(paths.human, `${hex}-beta-idea`), join(paths.human, `${hex}-one`));
		mkdirSync(join(paths.human, `${hex}-two`));
		writeFileSync(join(paths.human, `${hex}-two`, "idea.md"), "x");
		expect((await openWorkspace(root)).fixes).toEqual([]);
	});
});
