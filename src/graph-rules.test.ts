import { describe, expect, test } from "bun:test";
import { checkEdge, graphViolations, wouldCycle } from "./graph-rules.ts";
import type { EdgeRecord, EdgeRel, Graph, NodeRecord } from "./types.ts";

const AT = "2026-09-28T10:00:00Z";

function node(id: string, status = "shaping"): NodeRecord {
	const kind = id.startsWith("s-") ? "sprout" : "idea";
	const author = kind === "idea" ? "human:h" : "agent:a";
	return { type: "node", id, kind, slug: id, status, author, createdAt: AT } as NodeRecord;
}

function edge(id: string, from: string, rel: EdgeRel, to: string): EdgeRecord {
	return { type: "edge", id, from, to, rel, by: "human:h", createdAt: AT };
}

function graph(edges: EdgeRecord[] = [], extra: NodeRecord[] = []): Graph {
	return { nodes: [node("r-a"), node("r-b"), node("r-c"), node("s-x", "open"), ...extra], edges };
}

describe("checkEdge", () => {
	test("self edges, missing nodes, sprouts", () => {
		const g = graph();
		expect(checkEdge(g, { from: "r-a", to: "r-a", rel: "serves" })).toContain("itself");
		expect(checkEdge(g, { from: "r-a", to: "r-z", rel: "serves" })).toContain("r-z does not exist");
		expect(checkEdge(g, { from: "r-a", to: "s-x", rel: "tension" })).toContain("sprout");
		expect(checkEdge(g, { from: "r-a", to: "r-b", rel: "serves" })).toBeNull();
	});

	test("serves and replaces stay acyclic, per relation", () => {
		const g = graph([edge("e-1", "r-a", "serves", "r-b"), edge("e-2", "r-b", "serves", "r-c")]);
		expect(checkEdge(g, { from: "r-c", to: "r-a", rel: "serves" })).toContain("cycle");
		expect(checkEdge(g, { from: "r-b", to: "r-a", rel: "serves" })).toContain("cycle");
		expect(checkEdge(g, { from: "r-c", to: "r-a", rel: "replaces" })).toBeNull();
		const r = graph([edge("e-1", "r-a", "replaces", "r-b")], []);
		r.nodes = r.nodes.map((n) => (n.id === "r-b" ? { ...n, status: "composted" } : n));
		expect(checkEdge(r, { from: "r-b", to: "r-a", rel: "replaces" })).toContain("composted");
		expect(wouldCycle(g.edges, { from: "r-c", to: "r-a", rel: "serves" })).toBe(true);
	});

	test("tension is symmetric and stored once; duplicates refused", () => {
		const g = graph([edge("e-1", "r-a", "tension", "r-b"), edge("e-2", "r-a", "serves", "r-c")]);
		expect(checkEdge(g, { from: "r-b", to: "r-a", rel: "tension" })).toContain("e-1");
		expect(checkEdge(g, { from: "r-a", to: "r-c", rel: "serves" })).toContain("already exists");
		expect(checkEdge(g, { from: "r-a", to: "r-b", rel: "serves" })).toBeNull();
	});

	test("derives: only via adopt, idea → sprout", () => {
		const g = graph();
		expect(checkEdge(g, { from: "r-a", to: "s-x", rel: "derives" })).toContain("luuna-roots adopt");
		expect(
			checkEdge(g, { from: "r-a", to: "s-x", rel: "derives" }, { allowDerives: true }),
		).toBeNull();
		expect(
			checkEdge(g, { from: "r-a", to: "r-b", rel: "derives" }, { allowDerives: true }),
		).toContain("idea (r-) to a sprout");
	});

	test("composted ideas: never a source; only a replaces target", () => {
		const g = graph([], [node("r-d", "composted")]);
		expect(checkEdge(g, { from: "r-d", to: "r-a", rel: "serves" })).toContain("composted");
		expect(checkEdge(g, { from: "r-a", to: "r-d", rel: "tension" })).toContain("composted");
		expect(checkEdge(g, { from: "r-a", to: "r-d", rel: "replaces" })).toBeNull();
	});
});

describe("graphViolations", () => {
	test("a valid graph has none", () => {
		const g = graph([edge("e-1", "r-a", "serves", "r-b"), edge("e-2", "r-a", "derives", "s-x")]);
		expect(graphViolations(g)).toEqual([]);
	});

	test("reports cycles, duplicate tensions, bad derives, uncomposted replaces targets", () => {
		const g = graph([
			edge("e-1", "r-a", "serves", "r-b"),
			edge("e-2", "r-b", "serves", "r-a"),
			edge("e-3", "r-a", "tension", "r-c"),
			edge("e-4", "r-c", "tension", "r-a"),
			edge("e-5", "r-b", "derives", "r-c"),
			edge("e-6", "r-c", "replaces", "r-b"),
			edge("e-7", "r-a", "serves", "r-q"),
		]);
		const v = graphViolations(g);
		const by = (id: string) => v.find((x) => x.edge === id)?.message ?? "";
		expect(by("e-1")).toContain("cycle");
		expect(by("e-4")).toContain("duplicate of e-3");
		expect(by("e-5")).toContain("sprout");
		expect(by("e-6")).toContain("not composted");
		expect(by("e-7")).toContain("missing");
	});
});
