import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootsPaths } from "../paths.ts";
import {
	gitCommitAll,
	gitInit,
	initProject,
	patchConfig,
	plant,
	run,
	runJson,
	spawnCli,
	tempDir,
	writeSeeds,
} from "../test-helpers.ts";

interface DriftBody {
	skipped: string | null;
	files?: string[];
	commits?: { sha: string; subject: string }[];
	ideas: { id: string; slug: string; reasons: { kind: string; detail: string }[] }[];
	excluded?: string[];
}

async function tier3Repo(): Promise<string> {
	const root = await initProject();
	await patchConfig(root, { tier: 3 });
	return root;
}

function write(root: string, rel: string, text: string): void {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), text);
}

describe("luuna-roots drift", () => {
	test("hook-safe skips: outside a project, below tier 3, no git, bad rev", async () => {
		const outside = await run(["drift", "--diff", "HEAD"], tempDir());
		expect([outside.exitCode, outside.stdout, outside.stderr]).toEqual([0, "", ""]);
		const o = await runJson<DriftBody>(["drift"], tempDir());
		expect(o.body.skipped).toBe("not a roots project");

		const root = await initProject();
		const low = await run(["drift"], root);
		expect([low.exitCode, low.stdout, low.stderr]).toEqual([0, "", ""]);
		const lowJ = await runJson<DriftBody & { tier: number }>(["drift"], root);
		expect([lowJ.exitCode, lowJ.body.skipped, lowJ.body.tier]).toEqual([0, "tier", 2]);

		await patchConfig(root, { tier: 3 });
		const noGit = await runJson<DriftBody>(["drift"], root);
		expect(noGit.exitCode).toBe(0);
		expect(noGit.body.skipped).toBe("git: not a git work tree");

		gitInit(root);
		const bad = await runJson<DriftBody>(["drift", "--diff", "nope"], root);
		expect([bad.exitCode, bad.body.skipped]).toEqual([0, 'git: unknown revision "nope"']);
		const dash = await runJson<DriftBody>(["drift", "--diff=--output=/tmp/x"], root);
		expect(dash.exitCode).toBe(0);
		expect(dash.body.skipped).toContain("invalid revision");
	});

	test("nothing touched: silent; tool data (.luuna/roots/, .luuna/missions/) is ignored", async () => {
		const root = await tier3Repo();
		gitInit(root);
		await plant(root, "Offline sync never loses edits", ["--slug", "offline-sync"]);
		writeSeeds(root, [{ id: "sd-1", title: "offline sync", status: "open" }]);
		const r = await run(["drift"], root);
		expect([r.exitCode, r.stdout]).toEqual([0, ""]);
		const j = await runJson<DriftBody>(["drift"], root);
		expect(j.body.skipped).toBeNull();
		expect(j.body.files).toEqual([]);
	});

	test("slug, prose, seeds, commit and serves reasons; never writes", async () => {
		const root = await tier3Repo();
		const goal = await plant(root, "Users trust their data", ["--slug", "trust-data"]);
		const sync = await plant(root, "Offline sync never loses edits", ["--slug", "offline-sync"]);
		const store = await plant(root, "The store is append-only JSONL", ["--slug", "jsonl-log"]);
		const cli = await plant(root, "Every command speaks JSON", ["--slug", "json-everywhere"]);
		const quiet = await plant(root, "Leave me alone", ["--slug", "quiet-zone"]);
		await run(["link", sync, goal, "serves"], root);
		writeSeeds(root, [
			{
				id: "sd-1",
				title: `Wire output for ${cli}`,
				status: "open",
				description: "touch output.ts",
			},
		]);
		gitInit(root);
		write(root, "src/sync/offline.ts", "export {};\n");
		write(root, "src/output.ts", "export {};\n");
		write(root, "src/quiet/zone.ts", "export {};\n");
		gitCommitAll(root, `store: compact the log (${store})`);
		write(root, "src/sync/offline.ts", "export const x = 1;\n");
		await run(["tier", quiet, "1"], root);
		const before = readFileSync(rootsPaths(root).events, "utf8");

		const j = await runJson<DriftBody>(["drift", "--diff", "HEAD~1"], root);
		expect(j.exitCode).toBe(0);
		expect(j.body.files).toEqual(["src/output.ts", "src/quiet/zone.ts", "src/sync/offline.ts"]);
		const byId = new Map(j.body.ideas.map((i) => [i.id, i.reasons.map((r) => r.kind)]));
		expect(byId.get(sync)).toEqual(["slug"]);
		expect(byId.get(goal)).toEqual(["serves"]);
		expect(byId.get(store)).toEqual(["commit"]);
		expect(byId.get(cli)).toEqual(["seeds"]);
		expect(byId.has(quiet)).toBe(false);
		expect(j.body.excluded).toEqual([quiet]);
		expect(j.body.ideas.map((i) => i.id).at(-1)).toBe(goal);

		const md = await run(["drift", "--diff", "HEAD~1"], root);
		expect(md.stdout).toContain("# luuna-roots drift: 4 ideas touched by changes since HEAD~1");
		expect(md.stdout).toContain(`## ${sync} offline-sync (planted)`);
		expect(md.stdout).toContain("luuna-roots ask <id>");
		expect(md.stdout).toContain(`- serves: ${sync} offline-sync serves it`);

		// Default rev HEAD: only the uncommitted edit; the commit is out of range.
		const head = await runJson<DriftBody>(["drift"], root);
		expect(head.body.files).toEqual(["src/sync/offline.ts"]);
		expect(head.body.commits).toEqual([]);
		expect(head.body.ideas.map((i) => i.id)).toEqual([sync, goal]);

		expect(readFileSync(rootsPaths(root).events, "utf8")).toBe(before);
	});

	test("prose mention of a changed file; untracked files count", async () => {
		const root = await tier3Repo();
		gitInit(root);
		const id = await plant(root, "Parsing lives in src/yaml-lite.ts only", ["--slug", "parser"]);
		write(root, "src/yaml-lite.ts", "export {};\n");
		const j = await runJson<DriftBody>(["drift"], root);
		expect(j.body.ideas).toEqual([
			expect.objectContaining({
				id,
				reasons: [{ kind: "prose", detail: "the idea or its notes mention src/yaml-lite.ts" }],
			}),
		]);
	});

	test("smoke: the real binary, as the Stop hook runs it", async () => {
		const root = await tier3Repo();
		gitInit(root);
		const r = await spawnCli(["drift", "--diff", "HEAD"], root);
		expect([r.exitCode, r.stdout, r.stderr]).toEqual([0, "", ""]);
	});
});
