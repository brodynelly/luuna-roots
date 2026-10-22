import { describe, expect, test } from "bun:test";
import { makeColors } from "./color.ts";
import { type FlowCard, initialCard } from "./flow.ts";
import { renderFlowCard } from "./flow-render.ts";
import type { HeadingRecord } from "./types.ts";

const c = makeColors(false);
const F = { project: "warren", minutes: 23 };

const card: FlowCard = {
	...initialCard(),
	trail: {
		entries: [
			{
				id: "r-c818",
				slug: "team-agent-platform",
				status: "shaping",
				sessions: 1,
				answered: 3,
				open: 1,
			},
		],
		current: "r-c818",
		planted: [],
		adopted: ["r-0c3e"],
		accepted: 2,
		rejected: 0,
	},
	picks: [
		{ id: "r-7e52", slug: "no-secrets", reason: "1 open question", fromHeading: true },
		{ id: "r-506b", slug: "creds", reason: "never thought", fromHeading: false },
	],
};

describe("renderFlowCard", () => {
	test("trail, heading, inbox and keys; every line is the same width", () => {
		const heading = { id: "h-1", text: "Converging on principals (r-c818)." } as HeadingRecord;
		const lines = renderFlowCard(
			{ ...card, inbox: 3, heading: { kind: "shown", heading }, jobs: ["agent linking"] },
			F,
			70,
			c,
			30,
		);
		const text = lines.join("\n");
		expect(lines[0]).toContain("luuna-roots flow ── warren ── 23m ── inbox 3");
		expect(text).toContain("r-c818 team-agent-platform");
		expect(text).toContain("3 answered · 1 open  shaping  ← last");
		expect(text).toContain("+ adopted r-0c3e · accepted 2");
		expect(text).toContain("── heading ── [agent]");
		expect(text).toContain("Converging on principals (r-c818).");
		expect(text).toContain("… agent linking");
		expect(text).toContain("[enter] review inbox (3)");
		expect(text).toContain("[n] next: r-7e52 no-secrets · 1 open question ← heading");
		expect(text).toContain("[o] other idea (1 more)");
		expect(text).toContain("[x] dismiss heading");
		expect(lines).toHaveLength(30);
		expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
	});

	test("empty inbox: enter thinks the pick; waiting heading; empty flow plants", () => {
		const text = renderFlowCard({ ...card, heading: { kind: "waiting" } }, F, 70, c).join("\n");
		expect(text).toContain("[enter] think: r-7e52");
		expect(text).toContain("the agent is reading your session…");
		expect(text).not.toContain("[x]");
		const empty = renderFlowCard(initialCard(), F, 70, c).join("\n");
		expect(empty).toContain("nothing yet");
		expect(empty).toContain("[enter] plant an idea");
		expect(empty).not.toContain("heading");
		const bad = renderFlowCard({ ...card, notice: "! agent.command timed out" }, F, 70, c).join(
			"\n",
		);
		expect(bad).toContain("│ ! agent.command timed out");
	});

	test("a card taller than the terminal folds the trail and keeps the top border", () => {
		const entries = Array.from({ length: 20 }, (_, i) => ({
			id: `r-${(0xa000 + i).toString(16)}`,
			slug: `idea-${i}`,
			status: "shaping" as const,
			sessions: 1,
			answered: 1,
			open: 0,
		}));
		const long = { ...card, trail: { ...card.trail, entries, current: entries[19]?.id ?? null } };
		const lines = renderFlowCard({ ...long, notice: "idea-19 done" }, F, 70, c, 16);
		const text = lines.join("\n");
		expect(lines).toHaveLength(16);
		expect(lines[0]).toContain("luuna-roots flow ── warren");
		expect(text).toContain("earlier");
		expect(text).toContain("r-a013 idea-19");
		expect(text).toContain("✓ idea-19 done");
		expect(text).toContain("[q] end flow");
	});
});
