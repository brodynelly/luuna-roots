import { describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCISSORS } from "../editor.ts";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { findNode, readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { fileSprout } from "../sprouts.ts";
import { fakeEditor, forceStatus, initProject, run, runJson } from "../test-helpers.ts";
import type { EdgeRecord, NodeRecord } from "../types.ts";

const SPROUT_TEXT = "Conflicts get a merge UI";

async function setup() {
	const root = await initProject();
	const paths = rootsPaths(root);
	writeFileSync(join(root, "why.md"), "Agent body: users lose edits.\n");
	const s = await runJson<{ id: string }>(
		["sprout", SPROUT_TEXT, "--file", "why.md", "--as", "agent:opus"],
		root,
	);
	return { root, paths, sprout: s.body.id };
}

type Adopted = {
	id: string;
	slug: string;
	path: string;
	sprout: NodeRecord;
	edge: EdgeRecord;
	error?: string;
};

describe("luuna-roots adopt", () => {
	test("new idea in the human's words; derives edge; sprout adopted; sprout text never copied", async () => {
		const { root, paths, sprout } = await setup();
		const sproutFile = readFileSync(
			join(paths.sprouts, readdirSync(paths.sprouts)[0] ?? "", "sprout.md"),
			"utf8",
		);
		const editor = fakeEditor(root, "Humans resolve conflicts by hand\n\nIn my words.\n");
		const r = await runJson<Adopted>(["adopt", sprout], root, { env: { EDITOR: editor } });
		expect(r.exitCode).toBe(0);
		expect(r.stderr).toContain(SPROUT_TEXT); // shown for reference
		expect(r.stderr).toContain("reference only");
		expect(r.body.slug).toBe("humans-resolve-conflicts-hand");
		const idea = readFileSync(join(root, r.body.path), "utf8");
		expect(idea).toBe("Humans resolve conflicts by hand\n\nIn my words.\n");
		expect(idea).not.toContain(SPROUT_TEXT);
		expect(r.body.path.startsWith(".luuna/roots/human/")).toBe(true);
		const g = readGraph(paths);
		expect(findNode(g, r.body.id)).toMatchObject({
			kind: "idea",
			status: "planted",
			author: "human:test-human",
		});
		expect(findNode(g, sprout)).toMatchObject({ status: "adopted", decidedBy: "human:test-human" });
		expect(g.edges).toMatchObject([
			{ from: r.body.id, to: sprout, rel: "derives", by: "human:test-human" },
		]);
		expect(
			readFileSync(join(paths.sprouts, readdirSync(paths.sprouts)[0] ?? "", "sprout.md"), "utf8"),
		).toBe(sproutFile);
		const types = readEvents(paths).map((e) => e.type);
		expect(types.slice(-2)).toEqual(["plant", "adopt"]);
		// lineage both ways
		const fromSprout = await run(["show", sprout], root);
		expect(fromSprout.stdout).toContain(`adopted as ← ${r.body.id}`);
		expect(fromSprout.stdout).toContain("adopted by human:test-human");
		const fromIdea = await run(["show", r.body.id], root);
		expect(fromIdea.stdout).toContain(`derives`);
		expect(fromIdea.stdout).toContain(sprout);
		// once only; derives cannot be unlinked
		const again = await runJson(["adopt", sprout], root, { env: { EDITOR: editor } });
		expect(again.exitCode).toBe(EXIT.conflict);
		expect((await run(["unlink", r.body.edge.id], root)).exitCode).toBe(EXIT.usage);
	});

	test("the editor buffer quotes the sprout below the scissors; only text above is kept", async () => {
		const { root, sprout } = await setup();
		const seen = join(root, "seen.md");
		const editor = join(root, "prepend.sh");
		writeFileSync(
			editor,
			`#!/bin/sh\ncp "$1" '${seen}'\n{ printf 'Mine, not the agent\\n'; cat '${seen}'; } > "$1"\n`,
		);
		chmodSync(editor, 0o755);
		const r = await runJson<Adopted>(["adopt", sprout], root, { env: { EDITOR: editor } });
		expect(r.exitCode).toBe(0);
		const buffer = readFileSync(seen, "utf8");
		expect(buffer).toContain(SCISSORS);
		expect(buffer).toContain(`> ${SPROUT_TEXT}`);
		expect(buffer).toContain("> Agent body: users lose edits.");
		expect(readFileSync(join(root, r.body.path), "utf8")).toBe("Mine, not the agent\n");
	});

	test("--endorse: idea.md holds only the thoughts; readers quote the sprout as the agent's", async () => {
		const { root, paths, sprout } = await setup();
		const editor = fakeEditor(root, "Yes, and start with manual merges\n");
		const r = await runJson<Adopted & { idea: NodeRecord }>(["adopt", sprout, "--endorse"], root, {
			env: { EDITOR: editor },
		});
		expect(r.exitCode).toBe(0);
		expect(r.stderr).toContain("Endorsing");
		expect(r.body.slug).toBe("conflicts-get-merge-ui-2");
		const idea = readFileSync(join(root, r.body.path), "utf8");
		expect(idea).toBe("Yes, and start with manual merges\n");
		const node = findNode(readGraph(paths), r.body.id);
		expect(node?.endorses?.sprout).toBe(sprout);
		expect(node?.endorses?.hash).toMatch(/^sha256:/);
		expect(readEvents(paths).at(-1)).toMatchObject({ type: "adopt", mode: "endorse" });
		const label = `[agent] opus · ${sprout} · endorsed by human:test-human`;
		const show = await run(["show", r.body.id], root);
		expect(show.stdout).toContain(label);
		expect(show.stdout).toContain(`> ${SPROUT_TEXT}`);
		await forceStatus(root, r.body.id, "committed");
		const view = await run(["view"], root);
		expect(view.stdout).toContain(`> _${label}_`);
		expect(view.stdout).toContain("> Agent body: users lose edits.");
		const html = await run(["view", "--html"], root);
		expect(html.stdout).toContain('class="endorsed"');
		const prime = await run(["prime"], root);
		expect(prime.stdout).toContain(`endorses ${sprout} ([agent] text a human accepted)`);
		const ctx = await runJson<{ endorsed: { sprout: string } }>(["context", r.body.id], root);
		expect(ctx.body.endorsed.sprout).toBe(sprout);
		const md = await run(["context", r.body.id], root);
		expect(md.stdout).toContain("The human endorsed this agent text");
		// the pinned hash flags a sprout edited after endorsement
		const dir = join(paths.sprouts, readdirSync(paths.sprouts)[0] ?? "");
		writeFileSync(join(dir, "sprout.md"), "Something else\n");
		expect((await run(["show", r.body.id], root)).stdout).toContain("CHANGED since endorsement");
	});

	test("an empty save cancels: no node, no files, no events", async () => {
		const { root, paths, sprout } = await setup();
		const graph = readFileSync(paths.graph, "utf8");
		const events = readFileSync(paths.events, "utf8");
		const humans = readdirSync(paths.human);
		const r = await runJson(["adopt", sprout], root, { env: { EDITOR: "true" } });
		expect(r.exitCode).toBe(EXIT.error);
		expect(r.body).toMatchObject({ success: false, code: "cancelled" });
		const blank = await run(["adopt", sprout], root, {
			env: { EDITOR: fakeEditor(root, "\n  \n") },
		});
		expect(blank.exitCode).toBe(EXIT.error);
		expect(readFileSync(paths.graph, "utf8")).toBe(graph);
		expect(readFileSync(paths.events, "utf8")).toBe(events);
		expect(readdirSync(paths.human)).toEqual(humans);
		expect(findNode(readGraph(paths), sprout)?.status).toBe("open");
	});

	test("human command: TTY, no agent session, a sprout id, not expired", async () => {
		const { root, paths, sprout } = await setup();
		const editor = fakeEditor(root, "Mine\n");
		expect(
			(await run(["adopt", sprout], root, { tty: false, env: { EDITOR: editor } })).exitCode,
		).toBe(EXIT.guard);
		const agent = await run(["adopt", sprout], root, {
			env: { EDITOR: editor, ROOTS_AGENT: "agent:x" },
		});
		expect(agent.exitCode).toBe(EXIT.guard);
		const idea = (await runJson<{ id: string }>(["plant", "An idea"], root)).body.id;
		expect((await run(["adopt", idea], root, { env: { EDITOR: editor } })).exitCode).toBe(
			EXIT.usage,
		);
		const old = await fileSprout(paths, {
			statement: "Old one",
			by: "agent:opus",
			now: new Date(Date.now() - 40 * 86_400_000),
		});
		const expired = await runJson<{ error: string }>(["adopt", old.node.id], root, {
			env: { EDITOR: editor },
		});
		expect(expired.exitCode).toBe(EXIT.conflict);
		expect(findNode(readGraph(paths), old.node.id)?.status).toBe("expired");
	});
});

describe("accept / reject on sprouts", () => {
	test("accept s- on a TTY adopts; without a TTY it explains", async () => {
		const { root, paths, sprout } = await setup();
		const noTty = await runJson<{ error: string }>(["accept", sprout], root, { tty: false });
		expect(noTty.exitCode).toBe(EXIT.guard);
		expect(noTty.body.error).toContain(`luuna-roots adopt ${sprout}`);
		const editor = fakeEditor(root, "My own claim\n");
		const r = await runJson<{ sprout: NodeRecord; idea: NodeRecord }>(["accept", sprout], root, {
			env: { EDITOR: editor },
		});
		expect(r.exitCode).toBe(0);
		expect(r.body.sprout.status).toBe("adopted");
		expect(r.body.idea.slug).toBe("my-own-claim");
		expect(readGraph(paths).edges[0]?.rel).toBe("derives");
	});

	test("reject: status, decidedBy, reason; permanent; list/queue", async () => {
		const { root, paths, sprout } = await setup();
		const list = await runJson<{ nodes: NodeRecord[] }>(["list", "--kind", "sprout"], root);
		expect(list.body.nodes.map((n) => n.id)).toEqual([sprout]);
		const q = await runJson<{ sprouts: NodeRecord[] }>(["queue"], root);
		expect(q.body.sprouts.map((n) => n.id)).toEqual([sprout]);
		const r = await runJson<{ sprout: NodeRecord }>(
			["reject", sprout, "--reason", "not now"],
			root,
			{
				tty: false,
			},
		);
		expect(r.exitCode).toBe(0);
		expect(r.body.sprout).toMatchObject({ status: "rejected", decisionReason: "not now" });
		expect(findNode(readGraph(paths), sprout)?.decidedBy).toBe("human:test-human");
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "reject",
			node: sprout,
			reason: "not now",
		});
		expect((await runJson(["reject", sprout], root)).exitCode).toBe(EXIT.conflict);
		const again = await runJson(["sprout", SPROUT_TEXT, "--as", "agent:other"], root);
		expect(again.exitCode).toBe(EXIT.validation);
		const hidden = await runJson<{ nodes: NodeRecord[] }>(["list", "--kind", "sprout"], root);
		expect(hidden.body.nodes).toEqual([]);
		const all = await runJson<{ nodes: NodeRecord[] }>(["list", "--kind", "sprout", "--all"], root);
		expect(all.body.nodes).toHaveLength(1);
		expect(
			(await runJson(["reject", sprout], root, { env: { ROOTS_AGENT: "agent:x" } })).exitCode,
		).toBe(EXIT.guard);
	});
});
