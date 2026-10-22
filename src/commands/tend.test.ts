import { describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync } from "node:fs";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { findNode, readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { fileProposals, readProposals } from "../proposals.ts";
import { readNodeProse } from "../prose.ts";
import {
	fakeEditor,
	fakeTerminal,
	initProject,
	plant,
	run,
	runJson,
	waitFor,
} from "../test-helpers.ts";
import type { NodeRecord } from "../types.ts";

const AGENT = ["--as", "agent:opus"];

async function setup() {
	const root = await initProject();
	const a = await plant(root, "Sync works offline and nobody loses work");
	const b = await plant(root, "The server is always authoritative");
	const propose = async (args: string[]) => {
		const r = await runJson<{ id: string; error?: string }>(["propose", ...args, ...AGENT], root);
		if (r.exitCode !== 0) throw new Error(r.body.error);
		return r.body.id;
	};
	return { root, a, b, paths: rootsPaths(root), propose };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function edgeArgs(s: Setup, rel = "tension") {
	return [
		"edge",
		s.a,
		s.b,
		rel,
		"--reason",
		"offline vs server truth",
		"--cite",
		`${s.a}:nobody loses work`,
		"--cite",
		`${s.b}:server`,
	];
}

async function tend(root: string, script: (t: ReturnType<typeof fakeTerminal>) => Promise<void>) {
	const terminal = fakeTerminal(72);
	const running = run(["tend"], root, { terminal, env: { EDITOR: "true" } });
	await script(terminal);
	return running;
}

describe("luuna-roots tend", () => {
	test("needs a TTY and a human; --json lists cards without one", async () => {
		const s = await setup();
		const edge = await s.propose(edgeArgs(s));
		const compost = await s.propose([
			"compost",
			s.b,
			"--reason",
			"stale",
			"--cite",
			`${s.b}:server`,
		]);
		expect((await run(["tend"], s.root, { tty: false })).exitCode).toBe(EXIT.guard);
		const agent = await run(["tend"], s.root, { env: { ROOTS_AGENT: "agent:x" } });
		expect(agent.exitCode).toBe(EXIT.guard);
		const list = await runJson<{ cards: { id: string; expiresInDays: number }[] }>(
			["tend"],
			s.root,
			{
				tty: false,
			},
		);
		expect(list.body.cards.map((c) => c.id).sort()).toEqual([edge, compost].sort());
		expect(list.body.cards[0]?.expiresInDays).toBe(14);
		expect(readEvents(s.paths).filter((e) => e.type === "accept")).toHaveLength(0);
	});

	test("one card at a time: accept, reject with reason, summary", async () => {
		const s = await setup();
		const edge = await s.propose(edgeArgs(s));
		const compost = await s.propose([
			"compost",
			s.b,
			"--reason",
			"stale",
			"--cite",
			`${s.b}:server`,
		]);
		const r = await tend(s.root, async (t) => {
			await waitFor(() => t.screen().includes("card 1/2"), 3000, "first card");
			expect(t.screen()).toContain(`proposal ${edge}`);
			expect(t.screen()).toContain("↔ tension ↔");
			t.send("y");
			await waitFor(() => t.screen().includes("card 2/2"), 3000, "second card");
			expect(t.screen()).toContain(`compost  ${readGraph(s.paths).nodes[1]?.slug}`);
			t.send("rstill true\r");
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("tended 2 cards: 1 accepted, 1 rejected, 0 skipped");
		const edges = readGraph(s.paths).edges;
		expect(edges).toMatchObject([{ from: s.a, to: s.b, rel: "tension", proposal: edge }]);
		expect(readProposals(s.paths).find((p) => p.id === compost)).toMatchObject({
			status: "rejected",
			decisionReason: "still true",
		});
	});

	test("merged mention card: pick a relation; errors keep the card; q leaves the rest", async () => {
		const s = await setup();
		const node = findNode(readGraph(s.paths), s.a);
		if (!node) throw new Error("no node");
		appendFileSync(readNodeProse(s.paths, node).path ?? "", `\nUnlike ${s.b}, edits win.\n`);
		await run(["scan", s.a], s.root);
		await s.propose(edgeArgs(s));
		await s.propose(["compost", s.a, "--reason", "stale", "--cite", `${s.a}:Sync`]);
		await run(["link", s.b, s.a, "serves"], s.root);
		const r = await tend(s.root, async (t) => {
			await waitFor(() => t.screen().includes("[1] serves"), 3000, "mention card");
			expect(t.screen()).toMatch(/proposal p-\w+ \+ p-\w+/);
			t.send("1");
			await waitFor(() => t.screen().includes("cycle"), 3000, "cycle error");
			t.send("2");
			await waitFor(() => t.screen().includes("card 2/2"), 3000, "next card");
			t.send("q");
		});
		expect(r.stdout).toContain("1 accepted, 0 rejected, 0 skipped, 1 left");
		const tension = readGraph(s.paths).edges.find((e) => e.rel === "tension");
		expect(tension?.proposedBy).toBe("agent:opus");
		expect(readProposals(s.paths).filter((p) => p.status === "accepted")).toHaveLength(2);
	});

	test("accepting a split opens a think session with the split as guidance", async () => {
		const s = await setup();
		await s.propose([
			"split",
			s.a,
			"--reason",
			"offline editing / no data loss",
			"--cite",
			`${s.a}:and nobody`,
		]);
		const r = await tend(s.root, async (t) => {
			await waitFor(() => t.screen().includes("accept + think now"), 3000, "split card");
			t.send("y");
			await waitFor(() => t.screen().includes("split this idea"), 5000, "think screen");
			expect(t.screen()).toContain("offline editing / no data loss");
			t.send("q");
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("1 accepted");
		const types = readEvents(s.paths).map((e) => e.type);
		expect(types).toContain("session.start");
		expect(types.indexOf("accept")).toBeLessThan(types.indexOf("session.start"));
	});

	test("expires overdue proposals first; nothing to tend", async () => {
		const s = await setup();
		await fileProposals(
			s.paths,
			[
				{
					kind: "compost",
					from: s.a,
					reason: "old",
					cites: [{ node: s.a, quote: "Sync" }],
					by: "agent:opus",
				},
			],
			{ cap: 10, ttlDays: 1, now: new Date(Date.now() - 3 * 86_400_000) },
		);
		const r = await run(["tend"], s.root, { terminal: fakeTerminal() });
		expect(r.stdout).toContain("1 proposal(s) expired unreviewed");
		expect(r.stdout).toContain("Nothing to tend.");
		expect(readProposals(s.paths)[0]?.status).toBe("expired");
	});
	test("sprout cards: y adopts via the editor, n rejects", async () => {
		const s = await setup();
		const sprout = async (text: string) =>
			(await runJson<{ id: string }>(["sprout", text, ...AGENT], s.root)).body.id;
		const one = await sprout("Conflicts get a merge UI");
		const two = await sprout("Offline mode has a banner");
		const three = await sprout("Edits queue up locally");
		const editor = fakeEditor(s.root, "Humans resolve conflicts by hand\n");
		const terminal = fakeTerminal(72);
		const running = run(["tend"], s.root, { terminal, env: { EDITOR: editor } });
		await waitFor(() => terminal.screen().includes(`sprout ${one}`), 3000, "sprout card");
		expect(terminal.screen()).toContain("[y] rewrite as my idea");
		terminal.send("y");
		await waitFor(() => terminal.screen().includes(`sprout ${two}`), 5000, "second sprout");
		expect(terminal.screen()).toContain(`${one} adopted as r-`);
		terminal.send("n");
		await waitFor(() => terminal.screen().includes(`sprout ${three}`), 3000, "third sprout");
		terminal.send("q");
		const r = await running;
		expect(r.stdout).toContain("1 accepted, 1 rejected, 0 skipped, 1 left");
		const g = readGraph(s.paths);
		expect(findNode(g, one)?.status).toBe("adopted");
		expect(findNode(g, two)?.status).toBe("rejected");
		expect(g.edges.filter((e) => e.rel === "derives").map((e) => e.to)).toEqual([one]);
	});
	test("sprout card: [t] endorses with typed thoughts; ctrl-e continues in the editor", async () => {
		const s = await setup();
		const sprout = async (text: string) =>
			(await runJson<{ id: string }>(["sprout", text, ...AGENT], s.root)).body.id;
		const one = await sprout("Conflicts get a merge UI");
		const two = await sprout("Offline mode has a banner");
		const editor = fakeEditor(s.root, "Longer thoughts from the editor\n");
		const terminal = fakeTerminal(72);
		const running = run(["tend"], s.root, { terminal, env: { EDITOR: editor } });
		await waitFor(() => terminal.screen().includes(`sprout ${one}`), 3000, "sprout card");
		terminal.send("t");
		terminal.send("\r");
		await waitFor(() => terminal.screen().includes("write a thought first"), 3000, "empty guard");
		terminal.send("yes, but manual first");
		await waitFor(
			() => terminal.screen().includes("thoughts: yes, but manual first█"),
			3000,
			"box",
		);
		terminal.send("\r");
		await waitFor(() => terminal.screen().includes(`sprout ${two}`), 5000, "second sprout");
		expect(terminal.screen()).toContain(`${one} endorsed as r-`);
		terminal.send("tbanner\x05");
		const r = await running;
		expect(r.stdout).toContain("2 accepted, 0 rejected, 0 skipped");
		const g = readGraph(s.paths);
		const ideas = g.nodes.filter((n) => n.endorses);
		expect(ideas.map((n) => n.endorses?.sprout)).toEqual([one, two]);
		const [first, second] = ideas;
		expect(first?.slug).toBe("conflicts-get-merge-ui-2"); // from the sprout, not "yes-but"
		expect(readNodeProse(s.paths, first as NodeRecord).text).toBe("yes, but manual first\n");
		expect(readNodeProse(s.paths, second as NodeRecord).text).toBe(
			"Longer thoughts from the editor\n",
		);
		expect(
			readEvents(s.paths)
				.filter((e) => e.type === "adopt")
				.at(0),
		).toMatchObject({
			node: one,
			mode: "endorse",
		});
	});
	test("sprout card: an empty save cancels the adoption and skips the card", async () => {
		const s = await setup();
		const id = (await runJson<{ id: string }>(["sprout", "A sprout", ...AGENT], s.root)).body.id;
		const humans = readdirSync(s.paths.human);
		const r = await tend(s.root, async (t) => {
			await waitFor(() => t.screen().includes(`sprout ${id}`), 3000, "sprout card");
			t.send("y");
		});
		expect(r.stdout).toContain("0 accepted, 0 rejected, 1 skipped");
		expect(findNode(readGraph(s.paths), id)?.status).toBe("open");
		expect(readdirSync(s.paths.human)).toEqual(humans);
	});
});
