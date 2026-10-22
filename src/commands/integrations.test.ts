// Seeds/mulch integration through the CLI: show, queue, context, commit, verify.

import { describe, expect, test } from "bun:test";
import {
	forceStatus,
	initProject,
	patchConfig,
	plant,
	run,
	runJson,
	writeMulch,
	writeSeeds,
} from "../test-helpers.ts";

async function project() {
	const root = await initProject();
	const id = await plant(root, "Offline sync never loses edits", ["--slug", "offline-sync"]);
	const other = await plant(root, "Something else entirely", ["--slug", "other"]);
	writeSeeds(root, [
		{ id: "sd-1", title: "Queue writes locally", status: "closed", intent: id },
		{ id: "sd-2", title: `Replay on reconnect (${id})`, status: "open" },
		{ id: "sd-3", title: "Unrelated", status: "open", intent: other, description: `not ${id}` },
	]);
	writeMulch(root, "store", [
		{ id: "mx-1", type: "decision", title: "Use a local WAL", rationale: `for ${id}` },
		{ id: "mx-2", type: "pattern", name: "nope", description: "no id here" },
	]);
	return { root, id, other };
}

describe("seeds + mulch integration", () => {
	test("show lists linked issues and mulch learnings (human + json)", async () => {
		const { root, id } = await project();
		const r = await run(["show", id], root);
		expect(r.stdout).toContain("Seeds issues (1/2 closed)");
		expect(r.stdout).toContain("✓ sd-1 [closed] Queue writes locally");
		expect(r.stdout).toContain(`○ sd-2 [open] Replay on reconnect (${id})  (mentions)`);
		expect(r.stdout).not.toContain("sd-3");
		expect(r.stdout).toContain("Mulch learnings (1)");
		expect(r.stdout).toContain("mx-1 store/decision  Use a local WAL");
		const j = await runJson<{ seeds: { id: string; via: string }[]; mulch: { id: string }[] }>(
			["show", id],
			root,
		);
		expect(j.body.seeds.map((s) => [s.id, s.via])).toEqual([
			["sd-1", "intent"],
			["sd-2", "mention"],
		]);
		expect(j.body.mulch.map((m) => m.id)).toEqual(["mx-1"]);
	});

	test("no .luuna/missions/ or .luuna/atlas/: show has no such sections and json has empty lists", async () => {
		const root = await initProject();
		const id = await plant(root, "Plain idea");
		const r = await run(["show", id], root);
		expect(r.stdout).not.toContain("Seeds issues");
		const j = await runJson<{ seeds: unknown[]; mulch: unknown[] }>(["show", id], root);
		expect([j.body.seeds, j.body.mulch]).toEqual([[], []]);
	});

	test("queue prompts `built` only for committed ideas with every linked issue closed", async () => {
		const { root, id } = await project();
		await forceStatus(root, id, "committed");
		const open = await runJson<{ built: unknown[] }>(["queue"], root);
		expect(open.body.built).toEqual([]);
		writeSeeds(root, [
			{ id: "sd-1", title: "Queue writes locally", status: "closed", intent: id },
			{ id: "sd-2", title: `Replay (${id})`, status: "closed" },
		]);
		const j = await runJson<{
			built: { id: string; slug: string; issues: string[]; command: string }[];
		}>(["queue"], root);
		expect(j.body.built).toEqual([
			{ id, slug: "offline-sync", issues: ["sd-1", "sd-2"], command: `luuna-roots status ${id} built` },
		]);
		const r = await run(["queue"], root);
		expect(r.stdout).toContain("Ready to mark built (1)");
		expect(r.stdout).toContain(`luuna-roots status ${id} built`);
		// Never auto-changes status (invariant 5).
		const show = await runJson<{ node: { status: string } }>(["show", id], root);
		expect(show.body.node.status).toBe("committed");
	});

	test("context packet includes linked issues and learnings", async () => {
		const { root, id } = await project();
		const j = await runJson<{ seeds: { id: string }[]; mulch: { id: string }[] }>(
			["context", id, "--no-repo"],
			root,
		);
		expect(j.body.seeds.map((s) => s.id)).toEqual(["sd-1", "sd-2"]);
		expect(j.body.mulch.map((m) => m.id)).toEqual(["mx-1"]);
		const md = await run(["context", id, "--no-repo"], root);
		expect(md.stdout).toContain("## Seeds issues (the work that realizes this idea)");
		expect(md.stdout).toContain("- sd-1 [closed] Queue writes locally");
		expect(md.stdout).toContain("- mx-1 store/decision: Use a local WAL");
	});

	test("commit hints at seeds issues at tier ≥ 2 with .luuna/missions/ present", async () => {
		const { root, id, other } = await project();
		await forceStatus(root, id, "shaping");
		const j = await runJson<{ seedsHint: string | null }>(["commit", id], root);
		expect(j.body.seedsHint).toContain(`Realizes ${id}`);
		await forceStatus(root, other, "shaping");
		await patchConfig(root, { tier: 1 });
		const low = await runJson<{ seedsHint: string | null }>(["commit", other], root);
		expect(low.body.seedsHint).toBeNull();
		const bare = await initProject();
		const b = await plant(bare, "No seeds here");
		await forceStatus(bare, b, "shaping");
		const r = await run(["commit", b], bare);
		expect(r.stdout).not.toContain("Create seeds issues");
	});

	test("verify warns (seeds.open-on-built) when a built idea has open issues", async () => {
		const { root, id } = await project();
		await forceStatus(root, id, "built");
		const j = await runJson<{ warnings: number; issues: { code: string; node: string }[] }>(
			["verify"],
			root,
		);
		expect(j.exitCode).toBe(0);
		const w = j.body.issues.filter((i) => i.code === "seeds.open-on-built");
		expect(w).toEqual([expect.objectContaining({ node: id })]);
	});
});
