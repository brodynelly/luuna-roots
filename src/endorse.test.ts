import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimText, readClaim } from "./endorse.ts";
import { findNode, readGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { looksTooBig } from "./rules.ts";
import { fakeEditor, forceStatus, initProject, run, runJson } from "./test-helpers.ts";

const CLAIM = "Conflicts get a merge UI";

/** An endorsed idea whose thoughts are only "lgtm", plus a plain idea. */
async function setup() {
	const root = await initProject();
	const paths = rootsPaths(root);
	writeFileSync(join(root, "why.md"), "Users lose edits today.\n");
	const s = await runJson<{ id: string }>(
		["sprout", CLAIM, "--file", "why.md", "--as", "agent:opus"],
		root,
	);
	const r = await runJson<{ id: string }>(["adopt", s.body.id, "--endorse"], root, {
		env: { EDITOR: fakeEditor(root, "lgtm\n") },
	});
	const plain = await runJson<{ id: string }>(["plant", "Offline first"], root);
	return { root, paths, sprout: s.body.id, idea: r.body.id, plain: plain.body.id };
}

describe("endorsed ideas: the endorsed text is the claim (roots-9699)", () => {
	test("list, show, context and prime use the claim; idea.md is the thoughts", async () => {
		const { root, idea } = await setup();
		const list = await runJson<{ nodes: Array<{ id: string; statement: string }> }>(["list"], root);
		expect(list.body.nodes.find((n) => n.id === idea)?.statement).toBe(CLAIM);
		const show = await runJson<{ statement: string; body: string; thoughts: string }>(
			["show", idea],
			root,
		);
		expect(show.body).toMatchObject({
			statement: CLAIM,
			body: "Users lose edits today.",
			thoughts: "lgtm",
		});
		const text = (await run(["show", idea], root)).stdout;
		expect(text).toContain(`"${CLAIM}"`);
		expect(text).not.toContain('"lgtm"');
		expect(text).toContain("lgtm");
		const ctx = await runJson<{ statement: string; thoughts: string }>(["context", idea], root);
		expect(ctx.body).toMatchObject({ statement: CLAIM, thoughts: "lgtm" });
		const md = (await run(["context", idea], root)).stdout;
		expect(md).toContain("Their thoughts on it (idea.md):\n\nlgtm");
		await forceStatus(root, idea, "committed");
		const prime = (await run(["prime"], root)).stdout;
		expect(prime).toContain(`[committed]: ${CLAIM}`);
		expect(prime).toContain("; thoughts: lgtm");
	});

	test("view headings use the claim; the thoughts render under the quoted agent text", async () => {
		const { root, idea } = await setup();
		await forceStatus(root, idea, "committed");
		const view = (await run(["view"], root)).stdout;
		expect(view).toContain(`## ${CLAIM}\n`);
		expect(view).not.toContain("## lgtm");
		const quote = view.indexOf("> Users lose edits today.");
		expect(quote).toBeGreaterThan(-1);
		expect(view.indexOf("\nlgtm\n", quote)).toBeGreaterThan(quote);
		const html = (await run(["view", "--html"], root)).stdout;
		expect(html).toContain(`>${CLAIM}</h2>`);
	});

	test("--cite accepts a quote from the endorsed text or from the thoughts", async () => {
		const { root, idea, plain } = await setup();
		const propose = (quote: string) =>
			runJson<{ error?: string }>(
				[
					"propose",
					"edge",
					idea,
					plain,
					"serves",
					"--reason",
					"r",
					"--cite",
					`${idea}:${quote}`,
					"--cite",
					`${plain}:Offline`,
					"--as",
					"agent:opus",
				],
				root,
			);
		expect((await propose("merge UI")).exitCode).toBe(0);
		// same edge again: rejected as a duplicate, but only after the citations check out
		for (const quote of ["lose edits", "lgtm"]) {
			expect((await propose(quote)).body.error).not.toContain("cite quote not found");
		}
		const bad = await propose("not in either");
		expect(bad.body.error).toContain(`cite quote not found in ${idea}`);
	});

	test("rules judge the claim, not only the thoughts", async () => {
		const { paths, idea } = await setup();
		const node = findNode(readGraph(paths), idea);
		if (!node) throw new Error("no idea");
		const claim = readClaim(paths, readGraph(paths), node);
		expect(claim.statement).toBe(CLAIM);
		expect(claim.text).toBe(`${CLAIM}\n\nUsers lose edits today.\n\nlgtm\n`);
		if (!claim.endorsed) throw new Error("not endorsed");
		const big = { ...claim.endorsed, statement: "Merge UI and sync" };
		expect(looksTooBig(claimText("ok\n", big), 99)).toBe(true);
		expect(claimText("own\n", null)).toBe("own\n");
	});
});
