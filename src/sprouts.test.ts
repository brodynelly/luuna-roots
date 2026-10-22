import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { rejectItem } from "./decide.ts";
import { EXIT, type RootsError } from "./errors.ts";
import { readEvents } from "./events.ts";
import { findNode, readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import "./sprout-decide.ts";
import {
	expireSprouts,
	fileSprout,
	openSprouts,
	SPROUT_STATEMENT_MAX_LENGTH,
	sproutView,
	statementKey,
} from "./sprouts.ts";
import { initProject, patchConfig, plant } from "./test-helpers.ts";

const BY = "agent:opus";
const DAY = 86_400_000;

async function setup() {
	const root = await initProject();
	const idea = await plant(root, "Sync works offline and nobody loses work");
	return { root, idea, paths: rootsPaths(root) };
}

async function code(p: Promise<unknown>): Promise<number> {
	try {
		await p;
		return 0;
	} catch (err) {
		return (err as RootsError).exitCode ?? -1;
	}
}

describe("fileSprout", () => {
	test("writes only agent/sprouts/<hex>-<slug>/sprout.md; open, agent-authored, expiring", async () => {
		const { root, paths } = await setup();
		const humanBefore = readdirSync(paths.human);
		const now = new Date("2026-09-28T10:00:00Z");
		const r = await fileSprout(paths, {
			statement: "Conflicts get  a merge UI",
			body: "\nWhy: users lose edits.\n\n",
			by: BY,
			now,
		});
		expect(r.node).toMatchObject({
			kind: "sprout",
			status: "open",
			author: BY,
			slug: "conflicts-get-merge-ui",
			expiresAt: "2026-10-28T10:00:00Z",
		});
		expect(r.node.id).toMatch(/^s-[0-9a-f]{4}$/);
		expect(relative(root, r.file)).toBe(
			`.luuna/roots/agent/sprouts/${r.node.id.slice(2)}-conflicts-get-merge-ui/sprout.md`,
		);
		expect(readFileSync(r.file, "utf8")).toBe(
			"Conflicts get a merge UI\n\nWhy: users lose edits.\n",
		);
		expect(readdirSync(paths.human)).toEqual(humanBefore);
		const ev = readEvents(paths).filter((e) => e.type === "sprout");
		expect(ev).toMatchObject([{ by: BY, node: r.node.id, expiresAt: r.node.expiresAt }]);
	});

	test("guards: agent actor, project tier ≥ 2, one-line statement, length", async () => {
		const { root, paths } = await setup();
		expect(await code(fileSprout(paths, { statement: "x", by: "human:jay" }))).toBe(EXIT.guard);
		expect(await code(fileSprout(paths, { statement: "a\nb", by: BY }))).toBe(EXIT.validation);
		expect(await code(fileSprout(paths, { statement: "   ", by: BY }))).toBe(EXIT.usage);
		const long = "x".repeat(SPROUT_STATEMENT_MAX_LENGTH + 1);
		expect(await code(fileSprout(paths, { statement: long, by: BY }))).toBe(EXIT.validation);
		await patchConfig(root, { tier: 1 });
		expect(await code(fileSprout(paths, { statement: "ok then", by: BY }))).toBe(EXIT.guard);
		expect(existsSync(paths.sprouts) ? readdirSync(paths.sprouts) : []).toEqual([]);
	});

	test("cap: limits.sprouts open sprouts", async () => {
		const { root, paths } = await setup();
		await patchConfig(root, {
			limits: {
				proposals: 10,
				sprouts: 2,
				questionsPerSession: 3,
				proposalTtlDays: 14,
				sproutTtlDays: 30,
			},
		});
		await fileSprout(paths, { statement: "one", by: BY });
		await fileSprout(paths, { statement: "two", by: BY });
		expect(await code(fileSprout(paths, { statement: "three", by: BY }))).toBe(EXIT.validation);
		expect(openSprouts(readGraph(paths), new Date())).toHaveLength(2);
	});

	test("dedup: ideas, open and rejected sprouts block (rejections are permanent); expired does not", async () => {
		const { paths } = await setup();
		const idea = await code(
			fileSprout(paths, { statement: "sync works OFFLINE, and nobody loses work!", by: BY }),
		);
		expect(idea).toBe(EXIT.validation);
		const s = await fileSprout(paths, { statement: "Merge UI for conflicts", by: BY });
		expect(await code(fileSprout(paths, { statement: "merge ui for conflicts", by: BY }))).toBe(
			EXIT.validation,
		);
		await rejectItem({ paths, by: "human:jay" }, s.node.id, "no UI work this year");
		const again = fileSprout(paths, { statement: "Merge UI for conflicts.", by: BY });
		await expect(again).rejects.toThrow(/rejected it .*no UI work this year.*permanent/);

		const old = await fileSprout(paths, {
			statement: "Old idea nobody saw",
			by: BY,
			now: new Date(Date.now() - 40 * DAY),
		});
		const fresh = await fileSprout(paths, { statement: "old idea nobody saw", by: BY });
		expect(fresh.expired.map((n) => n.id)).toEqual([old.node.id]);
		expect(findNode(readGraph(paths), old.node.id)?.status).toBe("expired");
	});

	test("lazy expiry: read view vs expireSprouts (one expire event each)", async () => {
		const { paths } = await setup();
		const s = await fileSprout(paths, {
			statement: "Stale sprout",
			by: BY,
			now: new Date(Date.now() - 31 * DAY),
		});
		const node = findNode(readGraph(paths), s.node.id);
		if (!node) throw new Error("missing");
		expect(node.status).toBe("open");
		expect(sproutView(node, new Date()).status).toBe("expired");
		expect(openSprouts(readGraph(paths), new Date())).toHaveLength(0);
		const expired = await expireSprouts(paths);
		expect(expired.map((n) => n.id)).toEqual([s.node.id]);
		expect(await expireSprouts(paths)).toEqual([]);
		const ev = readEvents(paths).filter((e) => e.type === "expire");
		expect(ev).toMatchObject([{ by: "roots", node: s.node.id, kind: "sprout" }]);
	});

	test("statementKey ignores case, punctuation and spacing", () => {
		expect(statementKey("  Merge-UI, for conflicts! ")).toBe(
			statementKey("merge ui for CONFLICTS"),
		);
	});
});
