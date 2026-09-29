import { describe, expect, test } from "bun:test";
import { makeColors } from "./color.ts";
import {
	cardKeys,
	initialTend,
	inputChars,
	type ProposalCard,
	proposalCards,
	sortCards,
	sproutCard,
	type TendState,
	tendStep,
	tendTally,
} from "./tend.ts";
import { renderTend } from "./tend-render.ts";
import type { ProposalRecord } from "./types.ts";

const NOW = new Date("2026-09-28T12:00:00Z");
const slug = (id: string) => ({
	id,
	slug: id === "r-a1b2" ? "offline-sync" : "server-authoritative",
});

function prop(over: Partial<ProposalRecord>): ProposalRecord {
	return {
		id: "p-0001",
		kind: "edge",
		from: "r-a1b2",
		to: "r-e5f6",
		rel: "tension",
		reason: "offline writes conflict with 'server is the source of truth'",
		cites: [
			{ node: "r-a1b2", quote: "nobody loses work when the network drops" },
			{ node: "r-e5f6", quote: "the server is always authoritative" },
		],
		by: "agent:claude-opus-5-5",
		status: "pending",
		createdAt: "2026-09-28T11:30:00Z",
		expiresAt: "2026-10-09T11:30:00Z",
		...over,
	};
}

const mention = prop({
	id: "p-0002",
	from: "r-e5f6",
	to: "r-a1b2",
	rel: null,
	by: "roots:mention",
	reason: 'mentions offline-sync (slug: "offline sync")',
	cites: [
		{ node: "r-e5f6", quote: "unlike offline sync, we trust the server" },
		{ node: "r-a1b2", quote: "nobody loses work when the network drops" },
	],
	expiresAt: "2026-09-30T11:30:00Z",
});

describe("proposalCards", () => {
	test("a mention and an agent proposal on one pair merge into one card", () => {
		const other = prop({ id: "p-0003", kind: "compost", to: undefined, rel: undefined });
		const cards = proposalCards([prop({}), mention, other], slug);
		expect(cards).toHaveLength(2);
		const edge = cards.find((c) => c.kind === "edge") as ProposalCard;
		expect(edge).toMatchObject({
			id: "p-0001",
			ids: ["p-0001", "p-0002"],
			rel: "tension",
			pickRel: true,
			sources: ["agent:claude-opus-5-5", "roots:mention"],
			expiresAt: "2026-09-30T11:30:00Z",
		});
		expect(edge.cites).toHaveLength(3);
		expect(cards[0]?.id).toBe("p-0001"); // soonest expiry first
	});

	test("keys per card kind", () => {
		const keys = (p: ProposalRecord[]) =>
			cardKeys(proposalCards(p, slug)[0] as ProposalCard)
				.map((k) => k.key)
				.join("");
		expect(keys([prop({})])).toBe("ynrs");
		expect(keys([mention])).toBe("123nrs");
		expect(keys([prop({}), mention])).toBe("y123nrs");
		expect(keys([prop({ kind: "merge", rel: undefined })])).toBe("12nrs");
		expect(keys([prop({ kind: "split", to: undefined, rel: undefined })])).toBe("ynrs");
	});
});

function state(
	p: ProposalRecord[] = [prop({}), mention, prop({ id: "p-9", kind: "compost", to: undefined })],
) {
	return initialTend(proposalCards(p, slug));
}

function keys(s: TendState, data: string) {
	return tendStep(s, { type: "data", data });
}

describe("tend reducer", () => {
	test("y → decide effect; done advances; errors keep the card", () => {
		const s0 = state();
		const r = keys(s0, "y");
		expect(r.effects).toHaveLength(1);
		expect(r.effects[0]).toMatchObject({ card: { id: "p-0001" }, action: { type: "accept" } });
		expect(r.state.busy).toBe(true);
		expect(keys(r.state, "n").effects).toEqual([]); // busy: input waits
		const failed = tendStep(r.state, { type: "done", ok: false, error: "cycle" });
		expect(failed.state).toMatchObject({ index: 0, busy: false, error: "cycle" });
		const ok = tendStep(r.state, { type: "done", ok: true, outcome: "accepted", notice: "e-1" });
		expect(ok.state).toMatchObject({ index: 1, notice: "e-1", ended: false });
	});

	test("relation keys, skip, quit, unknown keys", () => {
		const s0 = state([mention]);
		expect(keys(s0, "2").effects[0]?.action).toEqual({ type: "accept", rel: "tension" });
		expect(keys(s0, "y").effects).toEqual([]);
		expect(keys(s0, "x").state).toEqual(s0);
		const skipped = keys(s0, "s");
		expect(skipped.state.ended).toBe(true);
		expect(tendTally(skipped.state)).toEqual({ accepted: 0, rejected: 0, skipped: 1, left: 0 });
		expect(keys(state(), "q").state.ended).toBe(true);
		expect(keys(state(), "\x03").state.ended).toBe(true);
	});

	test("r: type a reason, enter rejects; esc cancels; empty reason does nothing", () => {
		let s = keys(state(), "r").state;
		expect(s.reason).toBe("");
		s = keys(s, "not ").state;
		s = keys(s, "relatedx\x7f").state;
		expect(s.reason).toBe("not related");
		const r = keys(s, "\r");
		expect(r.effects[0]?.action).toEqual({ type: "reject", reason: "not related" });
		const esc = keys(keys(state(), "r").state, "\x1b");
		expect(esc.state).toMatchObject({ reason: null, notice: "cancelled" });
		expect(keys(keys(state(), "r").state, "\r").effects).toEqual([]);
		expect(inputChars("\x1b[Ay")).toEqual(["y"]);
	});
});

describe("renderTend", () => {
	test("fills the terminal height with [q] quit on the last row", () => {
		const lines = renderTend(
			{ state: state([prop({})]), now: NOW, expired: 0 },
			70,
			makeColors(false),
			40,
		);
		expect(lines).toHaveLength(40);
		expect(lines.at(-1)).toBe("[q] quit");
		expect(lines.at(-2)?.startsWith("└")).toBe(true);
		const short = renderTend(
			{ state: state([prop({})]), now: NOW, expired: 0 },
			70,
			makeColors(false),
			10,
		);
		expect(short).toHaveLength(10);
		expect(short[0]).toContain("roots tend");
		expect(short.join("\n")).toMatch(/… \d+ more lines?/);
		expect(short.at(-1)).toBe("[q] quit");
	});

	test("the card mockup", () => {
		const s = state([prop({})]);
		const text = renderTend({ state: s, now: NOW, expired: 2 }, 70, makeColors(false)).join("\n");
		expect(text).toContain("┌─ proposal p-0001 ── [agent] claude-opus-5-5 ── expires in 11d ─");
		expect(text).toContain("offline-sync  ↔ tension ↔  server-authoritative");
		expect(text).toContain(`"offline writes conflict with 'server is the source of truth'"`);
		expect(text).toContain(`  r-a1b2: "nobody loses work when the network drops"`);
		expect(text).toContain("[y] accept  [n] reject  [r] reject w/ reason  [s] skip");
		expect(text).toContain("2 proposals expired");
		for (const line of text.split("\n").filter((l) => l.startsWith("│"))) {
			expect([...line].length).toBe(70);
		}
	});

	test("merged mention card and reason prompt", () => {
		let s = state([prop({}), mention]);
		s = keys(s, "rtoo vague").state;
		const text = renderTend({ state: s, now: NOW, expired: 0 }, 60, makeColors(false)).join("\n");
		expect(text).toContain("p-0001 + p-0002");
		expect(text).toContain("mentions offline-sync");
		expect(text).toContain("expires in 2d");
		expect(text).toContain("[1] serves");
		expect(text).toContain("suggested: tension");
		expect(text).toContain("reason: too vague█");
	});
	test("sprout cards: adopt/reject keys, box, body excerpt, interleaved by expiry", () => {
		const sprout = sproutCard({
			id: "s-9f3e",
			slug: "conflict-ui",
			author: "agent:claude-opus-5-5",
			expiresAt: "2026-09-30T12:00:00Z",
			statement: "Conflicts get a merge UI",
			body: Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n"),
		});
		expect(cardKeys(sprout).map((k) => k.key)).toEqual(["t", "y", "n", "r", "s"]);
		const cards = sortCards([proposalCards([prop({})], slug)[0] as ProposalCard, sprout]);
		expect(cards.map((c) => c.id)).toEqual(["s-9f3e", "p-0001"]);
		const s0 = initialTend(cards);
		const text = renderTend(
			{ state: s0, now: NOW, expired: 0, expiredSprouts: 1 },
			70,
			makeColors(false),
		).join("\n");
		expect(text).toContain("┌─ sprout s-9f3e ── [agent] claude-opus-5-5 ── expires in 2d ─");
		expect(text).toContain("Conflicts get a merge UI");
		expect(text).toContain("line 9"); // the whole body
		expect(text).toContain("[t] accept w/ thoughts  [y] rewrite as my idea");
		expect(text).toContain("1 sprout expired");
		for (const line of text.split("\n").filter((l) => l.startsWith("│"))) {
			expect([...line].length).toBe(70);
		}
		const step = tendStep(s0, { type: "data", data: "y" });
		expect(step.effects).toEqual([{ type: "decide", card: sprout, action: { type: "accept" } }]);
		// [t]: type, backspace, enter → endorse; esc cancels; ctrl-e → editor
		const typed = tendStep(s0, { type: "data", data: "tok!\x7f" }).state;
		expect(typed.thoughts).toBe("ok");
		const boxed = renderTend({ state: typed, now: NOW, expired: 0 }, 70, makeColors(false));
		expect(boxed.join("\n")).toContain("thoughts: ok█");
		expect(tendStep(typed, { type: "data", data: "\r" }).effects).toEqual([
			{ type: "decide", card: sprout, action: { type: "endorse", text: "ok", editor: false } },
		]);
		expect(tendStep(typed, { type: "data", data: "\x05" }).effects[0]?.action).toEqual({
			type: "endorse",
			text: "ok",
			editor: true,
		});
		expect(tendStep(typed, { type: "data", data: "\x1b" }).state.thoughts).toBeNull();
		expect(tendStep(s0, { type: "data", data: "t\r" }).state.error).toContain("write a thought");
	});
});
