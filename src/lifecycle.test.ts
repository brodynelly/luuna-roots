import { describe, expect, test } from "bun:test";
import { parseIdeaStatus, transitionError } from "./lifecycle.ts";
import type { NodeRecord, NodeStatus } from "./types.ts";

function idea(status: NodeStatus): NodeRecord {
	return {
		type: "node",
		id: "r-a1b2",
		kind: "idea",
		slug: "a",
		status,
		author: "human:h",
		createdAt: "2026-09-28T10:00:00Z",
	};
}

describe("transitionError", () => {
	test("forward one step, or compost any live idea", () => {
		expect(transitionError(idea("shaping"), "committed")).toBeNull();
		expect(transitionError(idea("committed"), "built")).toBeNull();
		for (const s of ["planted", "shaping", "committed", "built"] as const) {
			expect(transitionError(idea(s), "composted")).toBeNull();
		}
	});

	test("refused transitions say why", () => {
		expect(transitionError(idea("planted"), "committed")).toContain("luuna-roots think r-a1b2");
		expect(transitionError(idea("shaping"), "built")).toContain("only from committed");
		expect(transitionError(idea("committed"), "shaping")).toContain("first `luuna-roots think`");
		expect(transitionError(idea("shaping"), "planted")).toContain("cannot be set by hand");
		expect(transitionError(idea("composted"), "committed")).toContain("stay composted");
		const sprout = { ...idea("open"), kind: "sprout" as const, id: "s-9f3e" };
		expect(transitionError(sprout, "composted")).toContain("sprout");
	});

	test("parseIdeaStatus", () => {
		expect(parseIdeaStatus("Built")).toBe("built");
		expect(() => parseIdeaStatus("done")).toThrow("unknown status");
	});
});
