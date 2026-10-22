import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { findNode, readGraph } from "../graph.ts";
import { rootsPaths } from "../paths.ts";
import { readProposals } from "../proposals.ts";
import { readNodeProse } from "../prose.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";
import type { EdgeRecord, ProposalRecord } from "../types.ts";

const AGENT = ["--as", "agent:opus"];

type Decided = {
	proposals: ProposalRecord[];
	edge: EdgeRecord | null;
	statusChanges: { node: string; from: string; to: string }[];
	think: { node: string; guidance: string } | null;
	error: string;
};

async function setup() {
	const root = await initProject();
	const a = await plant(root, "Sync works offline and nobody loses work");
	const b = await plant(root, "The server is always authoritative");
	return { root, a, b, paths: rootsPaths(root) };
}

async function proposeEdge(root: string, a: string, b: string, rel: string): Promise<string> {
	const r = await runJson<{ id: string; error?: string }>(
		[
			"propose",
			"edge",
			a,
			b,
			rel,
			"--reason",
			"why",
			"--cite",
			`${a}:Sync`,
			"--cite",
			`${b}:server`,
			...AGENT,
		],
		root,
	);
	if (r.exitCode !== 0) throw new Error(r.body.error);
	return r.body.id;
}

/** A human edit mentioning `b` by id, then `luuna-roots scan` files a rel:null mention proposal. */
async function mention(root: string, a: string, b: string): Promise<string> {
	const paths = rootsPaths(root);
	const node = findNode(readGraph(paths), a);
	if (!node) throw new Error("no node");
	appendFileSync(readNodeProse(paths, node).path ?? "", `\nThis pulls against ${b}.\n`);
	const r = await runJson<{ ideas: { filed: ProposalRecord[] }[] }>(["scan", a], root);
	const id = r.body.ideas[0]?.filed[0]?.id;
	if (!id) throw new Error("no mention filed");
	return id;
}

describe("luuna-roots accept", () => {
	test("edge: human makes the edge; provenance kept; one accept event", async () => {
		const { root, a, b, paths } = await setup();
		const p = await proposeEdge(root, a, b, "tension");
		const r = await runJson<Decided>(["accept", p], root, { tty: false });
		expect(r.exitCode).toBe(0);
		expect(r.body.edge).toMatchObject({
			from: a,
			to: b,
			rel: "tension",
			by: "human:test-human",
			proposedBy: "agent:opus",
			proposal: p,
		});
		const stored = readProposals(paths).find((x) => x.id === p);
		expect(stored).toMatchObject({ status: "accepted", decidedBy: "human:test-human" });
		expect(stored?.decidedAt).toBeString();
		expect(readGraph(paths).edges).toHaveLength(1);
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "accept",
			proposal: p,
			edge: r.body.edge?.id,
		});
		const again = await runJson<Decided>(["accept", p], root);
		expect(again.exitCode).toBe(EXIT.conflict);
		expect(again.body.error).toContain("already accepted by human:test-human");
	});

	test("mention proposals need --rel; a mention and an agent proposal are one decision", async () => {
		const { root, a, b, paths } = await setup();
		const m = await mention(root, a, b);
		const noRel = await runJson<Decided>(["accept", m], root);
		expect(noRel.exitCode).toBe(EXIT.usage);
		expect(noRel.body.error).toContain("--rel serves|tension|replaces");
		const agent = await proposeEdge(root, a, b, "tension");
		expect(readProposals(paths).filter((p) => p.status === "pending")).toHaveLength(2);
		const r = await runJson<Decided>(["accept", m, "--rel", "serves"], root);
		expect(r.exitCode).toBe(0);
		expect(r.body.edge).toMatchObject({
			from: a,
			to: b,
			rel: "serves",
			proposedBy: "roots:mention",
			proposal: m,
		});
		const status = Object.fromEntries(readProposals(paths).map((p) => [p.id, p]));
		expect(status[m]?.status).toBe("accepted");
		expect(status[agent]).toMatchObject({
			status: "rejected",
			decisionReason: "human chose serves",
		});
		expect(
			readEvents(paths).filter((e) => e.type === "accept" || e.type === "reject"),
		).toHaveLength(2);
	});

	test("merged card: the mention member lets the human pick another relation", async () => {
		const { root, a, b, paths } = await setup();
		const m = await mention(root, a, b);
		const agent = await proposeEdge(root, a, b, "tension");
		const wrong = await runJson<Decided>(["accept", agent, "--rel", "replaces"], root);
		expect(wrong.exitCode).toBe(0); // the mention member takes a relation
		expect(wrong.body.edge).toMatchObject({ rel: "replaces", proposal: m, from: a, to: b });
		expect(wrong.body.statusChanges).toEqual([{ node: b, from: "planted", to: "composted" }]);
		expect(findNode(readGraph(paths), b)?.status).toBe("composted");
		expect(readEvents(paths).at(-1)).toMatchObject({ type: "status", node: b, to: "composted" });
		expect(readProposals(paths).find((p) => p.id === agent)?.decisionReason).toBe(
			"human chose replaces",
		);
	});

	test("agent-only edge: --rel must match; otherwise reject and link", async () => {
		const { root, a, b } = await setup();
		const p = await proposeEdge(root, a, b, "tension");
		const r = await runJson<Decided>(["accept", p, "--rel", "serves"], root);
		expect(r.exitCode).toBe(EXIT.usage);
		expect(r.body.error).toContain(`luuna-roots link ${a} ${b} serves`);
	});

	test("invalid edges are refused and the proposal stays pending", async () => {
		const { root, a, b, paths } = await setup();
		const p = await proposeEdge(root, a, b, "serves");
		await run(["link", b, a, "serves"], root).catch(() => {});
		const r = await runJson<Decided>(["accept", p], root);
		expect(r.exitCode).toBe(EXIT.validation);
		expect(r.body.error).toContain("cycle");
		expect(readProposals(paths)[0]?.status).toBe("pending");
	});

	test("merge needs --keep; the survivor replaces the other", async () => {
		const { root, a, b, paths } = await setup();
		const p = await runJson<{ id: string }>(
			[
				"propose",
				"merge",
				a,
				b,
				"--reason",
				"dup",
				"--cite",
				`${a}:Sync`,
				"--cite",
				`${b}:server`,
				...AGENT,
			],
			root,
		);
		const noKeep = await runJson<Decided>(["accept", p.body.id], root);
		expect(noKeep.body.error).toContain(`--keep ${a} or --keep ${b}`);
		const r = await runJson<Decided>(["accept", p.body.id, "--keep", b], root);
		expect(r.body.edge).toMatchObject({ from: b, to: a, rel: "replaces", proposal: p.body.id });
		expect(findNode(readGraph(paths), a)?.status).toBe("composted");
	});

	test("split is marked accepted and hands off to think; compost composts", async () => {
		const { root, a, b, paths } = await setup();
		const split = await runJson<{ id: string }>(
			[
				"propose",
				"split",
				a,
				"--reason",
				"offline editing / no data loss",
				"--cite",
				`${a}:and nobody`,
				...AGENT,
			],
			root,
		);
		const r = await runJson<Decided>(["accept", split.body.id], root);
		expect(r.body.think).toEqual({ node: a, guidance: "offline editing / no data loss" });
		const human = await run(["accept", split.body.id], root);
		expect(human.stderr).toContain("already accepted");
		const compost = await runJson<{ id: string }>(
			["propose", "compost", b, "--reason", "stale", "--cite", `${b}:server`, ...AGENT],
			root,
		);
		const c = await runJson<Decided>(["accept", compost.body.id, "--reason", "yes"], root);
		expect(c.body.statusChanges).toEqual([{ node: b, from: "planted", to: "composted" }]);
		expect(readEvents(paths).at(-1)).toMatchObject({
			type: "compost",
			node: b,
			proposal: compost.body.id,
		});
		const text = await run(["accept", "p-0000"], root);
		expect(text.exitCode).toBe(EXIT.notFound);
	});

	test("guards: agents cannot accept; sprouts need a TTY (adopt); bad ids", async () => {
		const { root, a, b } = await setup();
		const p = await proposeEdge(root, a, b, "tension");
		const agent = await runJson<Decided>(["accept", p], root, {
			env: { ROOTS_AGENT: "agent:opus" },
		});
		expect(agent.exitCode).toBe(EXIT.guard);
		const noTty = await runJson<Decided>(["accept", "s-9f3e"], root, { tty: false });
		expect(noTty.exitCode).toBe(EXIT.guard);
		expect(noTty.body.error).toContain("luuna-roots adopt s-9f3e");
		const missing = await runJson<Decided>(["accept", "s-9f3e"], root);
		expect(missing.exitCode).toBe(EXIT.notFound);
		expect((await runJson<Decided>(["reject", a], root)).exitCode).toBe(EXIT.usage);
	});
});

describe("luuna-roots reject", () => {
	test("rejects the whole card; remembered permanently", async () => {
		const { root, a, b, paths } = await setup();
		const m = await mention(root, a, b);
		const agent = await proposeEdge(root, a, b, "tension");
		const r = await runJson<Decided>(["reject", agent, "--reason", "not related"], root, {
			tty: false,
		});
		expect(r.body.proposals.map((p) => p.id).sort()).toEqual([agent, m].sort());
		for (const p of readProposals(paths)) {
			expect(p).toMatchObject({ status: "rejected", decisionReason: "not related" });
		}
		const refile = await runJson<{ error: string }>(
			[
				"propose",
				"edge",
				a,
				b,
				"tension",
				"--reason",
				"x",
				"--cite",
				`${a}:Sync`,
				"--cite",
				`${b}:server`,
				...AGENT,
			],
			root,
		);
		expect(refile.body.error).toContain("a human already rejected this");
		const rescan = await runJson<{ ideas: { filed: unknown[] }[] }>(["scan", a, "--all"], root);
		expect(rescan.body.ideas[0]?.filed).toEqual([]);
		const human = await run(["reject", agent], root);
		expect(human.stderr).toContain("already rejected");
	});
});
