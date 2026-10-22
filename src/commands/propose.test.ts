import { describe, expect, test } from "bun:test";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { rootsPaths } from "../paths.ts";
import { readProposals } from "../proposals.ts";
import { initProject, patchConfig, plant, run, runJson } from "../test-helpers.ts";
import type { ProposalRecord } from "../types.ts";

const AGENT = ["--as", "agent:opus"];
const OFFLINE = "Sync works offline: nobody loses work when the network drops";
const SERVER = "The server is always authoritative";

async function setup() {
	const root = await initProject();
	const a = await plant(root, OFFLINE);
	const b = await plant(root, SERVER);
	return { root, a, b, paths: rootsPaths(root) };
}

type Body = { id: string; proposal: ProposalRecord; error: string; code: string };

describe("luuna-roots propose edge", () => {
	test("files a validated edge proposal; quotes may contain colons", async () => {
		const { root, a, b, paths } = await setup();
		const r = await runJson<Body>(
			[
				"propose",
				"edge",
				a,
				"server-always-authoritative",
				"tension",
				"--reason",
				"offline writes conflict with 'server is the source of truth'",
				"--cite",
				`${a}:offline: nobody loses work`,
				"--cite",
				`${b}:"the server is always authoritative"`.replace("the", "The"),
				...AGENT,
			],
			root,
			{ tty: false },
		);
		expect(r.exitCode).toBe(0);
		expect(r.body.proposal).toMatchObject({
			kind: "edge",
			from: a,
			to: b,
			rel: "tension",
			by: "agent:opus",
			status: "pending",
			cites: [
				{ node: a, quote: "offline: nobody loses work" },
				{ node: b, quote: "The server is always authoritative" },
			],
		});
		expect(readProposals(paths)).toHaveLength(1);
		expect(readEvents(paths).at(-1)).toMatchObject({ type: "propose", by: "agent:opus", node: a });
	});

	test("clear errors quoting what failed", async () => {
		const { root, a, b } = await setup();
		const base = ["propose", "edge", a, b, "serves", "--reason", "r", ...AGENT];
		const cite = (x: string) => ["--cite", x];
		const cases: [string[], number, string][] = [
			[
				[...cite(`${a}:nobody`), ...cite(`${b}:no such words`)],
				EXIT.validation,
				`cite quote not found in ${b}`,
			],
			[[...cite(`${a}:nobody`)], EXIT.validation, "at least 2 citation"],
			[
				[...cite(`${a}:nobody`), ...cite(`${a}:offline`)],
				EXIT.validation,
				`cite at least one quote from ${b}`,
			],
			[[...cite("nocolon")], EXIT.usage, "--cite must be <id>:<quote>"],
		];
		for (const [extra, code, msg] of cases) {
			const r = await runJson<Body>([...base, ...extra], root);
			expect(r.exitCode).toBe(code);
			expect(r.body.error).toContain(msg);
		}
		const noReason = await runJson<Body>(
			["propose", "edge", a, b, "serves", "--cite", `${a}:nobody`, "--cite", `${b}:The`, ...AGENT],
			root,
		);
		expect(noReason.body.error).toContain("--reason is required");
		const derives = await runJson<Body>(
			[...base.slice(0, 4), "derives", "--reason", "r", ...AGENT],
			root,
		);
		expect(derives.body.error).toContain("luuna-roots adopt");
		const self = await runJson<Body>(
			["propose", "edge", a, a, "serves", "--reason", "r", ...AGENT],
			root,
		);
		expect(self.body.error).toContain(`both ends are ${a}`);
	});

	test("agents only; tier ≥ 2 on every idea involved", async () => {
		const { root, a, b, paths } = await setup();
		const args = ["propose", "edge", a, b, "serves", "--reason", "r", "--cite", `${a}:nobody`];
		const withB = [...args, "--cite", `${b}:The server`];
		const human = await runJson<Body>([...withB, "--as", "human:me"], root);
		expect(human.exitCode).toBe(EXIT.guard);
		const anon = await runJson<Body>(withB, root);
		expect(anon.exitCode).toBe(EXIT.guard);
		await run(["tier", b, "1"], root);
		const low = await runJson<Body>([...withB, ...AGENT], root);
		expect(low.exitCode).toBe(EXIT.guard);
		expect(low.body.error).toContain(`${b} is at tier 1`);
		await run(["tier", b, "default"], root);
		await patchConfig(root, { tier: 1 });
		const project = await runJson<Body>([...withB, ...AGENT], root);
		expect(project.body.error).toContain("this project is at tier 1");
		expect(readProposals(paths)).toHaveLength(0);
	});

	test("graph invariants, cap, duplicates and permanent rejections", async () => {
		const { root, a, b } = await setup();
		const c = await plant(root, "Local first storage everywhere");
		await run(["link", a, b, "serves"], root);
		const cycle = await runJson<Body>(
			[
				"propose",
				"edge",
				b,
				a,
				"serves",
				"--reason",
				"r",
				"--cite",
				`${a}:nobody`,
				"--cite",
				`${b}:The`,
				...AGENT,
			],
			root,
		);
		expect(cycle.body.error).toContain("cycle");
		const edge = (x: string, y: string) => [
			"propose",
			"edge",
			x,
			y,
			"tension",
			"--reason",
			"r",
			"--mention",
			"--cite",
			`${x}:${x === c ? "Local" : x === a ? "nobody" : "The"}`,
			...AGENT,
		];
		const first = await runJson<Body>(edge(a, c), root);
		expect(first.exitCode).toBe(0);
		expect(first.body.proposal.cites).toContainEqual({
			node: c,
			quote: "Local first storage everywhere",
		});
		const dup = await runJson<Body>(edge(c, a), root);
		expect(dup.exitCode).toBe(EXIT.conflict);
		expect(dup.body.error).toContain(`already proposed as ${first.body.id}`);
		await run(["reject", first.body.id, "--reason", "unrelated"], root);
		const again = await runJson<Body>(edge(a, c), root);
		expect(again.exitCode).toBe(EXIT.conflict);
		expect(again.body.error).toContain(`a human already rejected this (${first.body.id})`);
		await patchConfig(root, {
			limits: {
				proposals: 1,
				sprouts: 5,
				questionsPerSession: 3,
				proposalTtlDays: 14,
				sproutTtlDays: 30,
			},
		});
		expect((await runJson<Body>(edge(b, c), root)).exitCode).toBe(0);
		const capped = await runJson<Body>(
			["propose", "compost", c, "--reason", "stale", "--cite", `${c}:Local`, ...AGENT],
			root,
		);
		expect(capped.body.error).toContain("at the limit (1)");
	});
});

describe("luuna-roots propose split|merge|compost", () => {
	test("shapes and citation rules", async () => {
		const { root, a, b } = await setup();
		const split = await runJson<Body>(
			[
				"propose",
				"split",
				a,
				"--reason",
				"offline editing vs. no data loss",
				"--cite",
				`${a}:nobody loses work`,
				...AGENT,
			],
			root,
		);
		expect(split.body.proposal).toMatchObject({ kind: "split", from: a });
		expect(split.body.proposal.to).toBeUndefined();
		const splitOther = await runJson<Body>(
			["propose", "split", a, "--reason", "r", "--cite", `${b}:The server`, ...AGENT],
			root,
		);
		expect(splitOther.body.error).toContain(`cite at least one quote from ${a}`);
		const merge = await runJson<Body>(
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
		expect(merge.body.proposal).toMatchObject({ kind: "merge", from: a, to: b });
		const compost = await runJson<Body>(
			[
				"propose",
				"compost",
				b,
				"--reason",
				"covered by offline sync",
				"--cite",
				`${b}:server`,
				"--cite",
				`${a}:Sync`,
				...AGENT,
			],
			root,
		);
		expect(compost.exitCode).toBe(0);
		const bad = await runJson<Body>(["propose", "graft", a, "--reason", "r", ...AGENT], root);
		expect(bad.body.error).toContain("unknown proposal kind");
		const arity = await runJson<Body>(["propose", "merge", a, "--reason", "r", ...AGENT], root);
		expect(arity.body.error).toContain("usage: luuna-roots propose merge <a> <b>");
		const mention = await runJson<Body>(
			["propose", "split", a, "--mention", "--reason", "r", "--cite", `${a}:Sync`, ...AGENT],
			root,
		);
		expect(mention.body.error).toContain("--mention applies to `propose edge` only");
	});
});
