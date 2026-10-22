import { describe, expect, test } from "bun:test";
import { rootsPaths } from "../paths.ts";
import { fileProposals, MENTION_ACTOR } from "../proposals.ts";
import { addQuestions } from "../questions.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

describe("luuna-roots queue", () => {
	test("empty project", async () => {
		const root = await initProject();
		const r = await run(["queue"], root);
		expect(r.stdout).toBe("Nothing needs attention.\n");
	});

	test("think order, open questions, pending proposals", async () => {
		const root = await initProject();
		const paths = rootsPaths(root);
		const a = await plant(root, "Sync works offline");
		const b = await plant(root, "Done when shipped, not before");
		const [q] = await addQuestions(paths, [{ node: b, text: "Why now?", by: "agent:claude" }]);
		const qid = q?.id ?? "";
		await fileProposals(
			paths,
			[
				{
					kind: "edge",
					from: a,
					to: b,
					rel: null,
					cites: [
						{ node: a, quote: "Sync works offline" },
						{ node: b, quote: "not before" },
					],
					by: MENTION_ACTOR,
				},
			],
			{ cap: 10, ttlDays: 14 },
		);
		const { body } = await runJson<{
			think: Array<{ id: string; open: string[]; candidates: string[] }>;
			questions: Array<{ id: string }>;
			proposals: Array<{ from: string }>;
		}>(["queue"], root);
		expect(body.think.map((t) => t.id)).toEqual([b, a]);
		expect(body.think[0]?.open).toEqual([qid]);
		expect(body.think[1]?.candidates).toEqual(["missing-done", "missing-scope"]);
		expect(body.questions.map((x) => x.id)).toEqual([qid]);
		expect(body.proposals).toMatchObject([{ from: a }]);

		const h = await run(["queue"], root);
		expect(h.stdout).toContain("Think next");
		expect(h.stdout).toContain("Why now?  [agent]");
		expect(h.stdout).toContain("sync-works-offline ─?─ done-when-shipped-not");
		expect(h.stdout).toContain("expires in 14d");
		expect(body).toMatchObject({ expiring: [] });

		await fileProposals(
			paths,
			[
				{
					kind: "compost",
					from: b,
					reason: "stale",
					cites: [{ node: b, quote: "not before" }],
					by: "agent:claude",
				},
			],
			{ cap: 10, ttlDays: 2 },
		);
		const soon = await runJson<{ expiring: string[] }>(["queue"], root);
		expect(soon.body.expiring).toHaveLength(1);
		const h2 = await run(["queue"], root);
		expect(h2.stdout).toContain("Pending proposals (2, 1 expiring soon)");
		expect(h2.stdout).toContain("compost done-when-shipped-not");
		const shown = await runJson<{ proposals: Array<{ kind: string }> }>(["show", b], root);
		expect(shown.body.proposals.map((p) => p.kind).sort()).toEqual(["compost", "edge"]);
		const showText = await run(["show", b], root);
		expect(showText.stdout).toContain("Pending proposals (2)");
		expect(showText.stdout).toContain("? sync-works-offline");
	});

	test("proposals about a composted idea leave the queue (and expire in tend)", async () => {
		const root = await initProject();
		const paths = rootsPaths(root);
		const a = await plant(root, "Sync works offline");
		const b = await plant(root, "Done when shipped, not before");
		await fileProposals(
			paths,
			[
				{
					kind: "edge",
					from: a,
					to: b,
					rel: null,
					cites: [
						{ node: a, quote: "Sync works offline" },
						{ node: b, quote: "not before" },
					],
					by: MENTION_ACTOR,
				},
			],
			{ cap: 10, ttlDays: 14 },
		);
		const before = await runJson<{ proposals: unknown[] }>(["queue"], root);
		expect(before.body.proposals).toHaveLength(1);
		const c = await run(["compost", b], root);
		expect(c.exitCode).toBe(0);
		const after = await runJson<{ proposals: unknown[] }>(["queue"], root);
		expect(after.body.proposals).toEqual([]);
		const show = await runJson<{ proposals: unknown[] }>(["show", a], root);
		expect(show.body.proposals).toEqual([]);
	});
});
