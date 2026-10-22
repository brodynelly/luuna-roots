import { describe, expect, test } from "bun:test";
import { makeColors, visibleLength } from "./color.ts";
import { renderScreen, type ScreenView, wrapText } from "./think-screen.ts";

const plain = makeColors(false);

const VIEW: ScreenView = {
	id: "r-a1b2",
	slug: "offline-sync",
	status: "shaping",
	statement: "Sync works fully offline, and nobody loses work when the network drops.",
	edges: [
		{ rel: "serves", direction: "out", id: "r-c3d4", slug: "local-first" },
		{ rel: "tension", direction: "in", id: "r-e5f6", slug: "server-authoritative" },
	],
	question: {
		id: "q-7f3a",
		text: "What happens to an offline edit on a record someone else deleted?",
		source: "agent",
		index: 2,
		total: 3,
	},
	notice: "answered (lines 3–5)",
	editorHint: "Editing .luuna/roots/human/a1b2-offline-sync/idea.md in a tmux pane.",
};

describe("think screen", () => {
	test("fills the terminal height with keys at the bottom", () => {
		const lines = renderScreen(VIEW, 60, plain, 30);
		expect(lines).toHaveLength(30);
		const bottom = lines.findIndex((l) => l.startsWith("└"));
		expect(lines[bottom - 1]).toContain("[q] end session");
	});

	test("findings under a delegated question; [a] when agents may work", () => {
		const view: ScreenView = {
			...VIEW,
			canDelegate: true,
			question: {
				...(VIEW.question as NonNullable<ScreenView["question"]>),
				findings: { text: "Postgres raises unless ON CONFLICT is given.", path: "n/f.md" },
			},
		};
		const text = renderScreen(view, 60, plain).join("\n");
		expect(text).toContain("── findings ── [agent]");
		expect(text).toContain("Postgres raises unless ON CONFLICT is given.");
		expect(text).toContain("full: n/f.md");
		expect(text).toContain("[a] ask agent");
		expect(renderScreen(VIEW, 60, plain).join("\n")).not.toContain("[a]");
	});

	test("a short terminal folds links instead of scrolling the title off", () => {
		const full = renderScreen(VIEW, 60, plain).length;
		const short = renderScreen(VIEW, 60, plain, full - 1);
		expect(short).toHaveLength(full - 1);
		expect(short[0]).toContain("luuna-roots think offline-sync");
		expect(short.join("\n")).toContain("2 links (terminal too short)");
		expect(short.join("\n")).toContain("[q] end session");
	});

	test("matches the mockup layout at 42 columns", () => {
		const lines = renderScreen(VIEW, 42, plain);
		expect(lines.join("\n")).toBe(
			[
				"┌─ luuna-roots think offline-sync ─────────────┐",
				"│ r-a1b2  offline-sync           shaping │",
				'│ "Sync works fully offline, and nobody… │',
				"│                                        │",
				"│ serves     → r-c3d4 local-first        │",
				"│ tension    ↔ r-e5f6 server-authoritat… │",
				"│                                        │",
				"│ ── question 2/3 · q-7f3a ── [agent] ── │",
				"│ What happens to an offline edit on a   │",
				"│ record someone else deleted?           │",
				"│                                        │",
				"│ ✓ answered (lines 3–5)                 │",
				"│ [save] answer  [d] dismiss  [z] snooze │",
				"│ [s] skip       [q] end session         │",
				"└────────────────────────────────────────┘",
				" Editing",
				" .luuna/roots/human/a1b2-offline-sync/idea.md",
				" in a tmux pane.",
			].join("\n"),
		);
	});

	test("every box line has the same visible width, with color on", () => {
		const lines = renderScreen(VIEW, 60, makeColors(true));
		const box = lines.slice(0, lines.findIndex((l) => l.includes("└")) + 1);
		expect(new Set(box.map(visibleLength))).toEqual(new Set([60]));
	});

	test("no question and no edges", () => {
		const text = renderScreen({ ...VIEW, question: null, edges: [], notice: null }, 50, plain).join(
			"\n",
		);
		expect(text).toContain("(no links yet)");
		expect(text).toContain("── no questions ──");
		expect(text).toContain("[q] end session");
		expect(text).not.toContain("[d] dismiss");
	});

	test("wrapText", () => {
		expect(wrapText("a bb ccc", 4)).toEqual(["a bb", "ccc"]);
		expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
		expect(wrapText("x\ny", 10)).toEqual(["x", "y"]);
	});
});

describe("think screen, narrow", () => {
	test("status survives, borders align, keys wrap instead of truncating", () => {
		const lines = renderScreen({ ...VIEW, slug: "sync-works-offline-nobody" }, 34, plain);
		const box = lines.slice(0, lines.findIndex((l) => l.includes("└")) + 1);
		expect(new Set(box.map((l) => [...l].length))).toEqual(new Set([34]));
		expect(box[1]).toMatch(/shaping │$/);
		const text = box.join("\n");
		for (const k of ["[save] answer", "[d] dismiss", "[z] snooze", "[s] skip", "[q] end session"]) {
			expect(text).toContain(k);
		}
	});
});
