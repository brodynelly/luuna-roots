import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { forceStatus, initProject, plant, run } from "./test-helpers.ts";
import type { ViewData } from "./view.ts";
import { esc, layoutView, renderViewHtml, servesDepths } from "./view-html.ts";

const EVIL = `<script>alert("x")</script><img src=x onerror='alert(1)'>`;

function ideaDir(root: string, id: string): string {
	const dir = join(root, ".luuna/roots", "human");
	return join(dir, readdirSync(dir).find((n) => n.startsWith(`${id.slice(2)}-`)) ?? "");
}

describe("esc", () => {
	test("escapes the five HTML metacharacters", () => {
		expect(esc(`<a href="x" title='y'>&</a>`)).toBe(
			"&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});
});

describe("layout", () => {
	const data: ViewData = {
		project: "p",
		from: null,
		tree: [],
		unanchored: [],
		tensions: [],
		questions: [],
		sprouts: [{ id: "s-1", slug: "sp", statement: "s", body: "", by: "agent:a", expiresAt: null }],
		ideas: {
			"r-a": { id: "r-a", slug: "a", status: "committed", statement: "A", body: "", blocks: [] },
			"r-b": { id: "r-b", slug: "b", status: "shaping", statement: "B", body: "", blocks: [] },
			"r-c": { id: "r-c", slug: "c", status: "planted", statement: "C", body: "", blocks: [] },
		},
		edges: [
			{ from: "r-b", to: "r-a", rel: "serves" },
			{ from: "r-c", to: "r-b", rel: "serves" },
			{ from: "r-c", to: "r-a", rel: "serves" },
		],
	};

	test("layers by longest serves path; sprouts get their own dimmed row", () => {
		const d = servesDepths(data);
		expect([d.get("r-a"), d.get("r-b"), d.get("r-c")]).toEqual([0, 1, 2]);
		const l = layoutView(data);
		const y = (id: string) => l.nodes.find((n) => n.id === id)?.y ?? -1;
		expect(y("r-a")).toBeLessThan(y("r-b"));
		expect(y("r-b")).toBeLessThan(y("r-c"));
		expect(y("r-c")).toBeLessThan(y("s-1"));
		expect(l.nodes.find((n) => n.id === "s-1")?.agent).toBe(true);
	});

	test("a corrupted serves cycle does not hang", () => {
		const cyc = {
			...data,
			edges: [
				{ from: "r-a", to: "r-b", rel: "serves" as const },
				{ from: "r-b", to: "r-a", rel: "serves" as const },
			],
		};
		expect(servesDepths(cyc).size).toBe(3);
		expect(renderViewHtml(cyc, () => [])).toContain("<svg");
	});
});

describe("luuna-roots view --html", () => {
	test("self-contained, XSS-safe, graph + timeline, agent content dimmed", async () => {
		const root = await initProject();
		const goal = await plant(root, `Goal ${EVIL}`, ["--slug", "goal"]);
		const sub = await plant(root, "Sub idea", ["--slug", "sub"]);
		await forceStatus(root, goal, "committed");
		await updateGraph(rootsPaths(root), (g) => {
			g.edges.push({
				type: "edge",
				id: "e-0001",
				from: sub,
				to: goal,
				rel: "serves",
				by: "human:t",
				createdAt: "2026-01-01T00:00:00Z",
			});
			return { write: true, result: null };
		});
		writeFileSync(join(ideaDir(root, goal), "idea.md"), `Goal ${EVIL}\n\nBody "${EVIL}" & more\n`);
		const sp = await run(["sprout", `Sprout ${EVIL}`, "--json"], root, {
			env: { ROOTS_AGENT: "agent:test" },
			tty: false,
		});
		expect(sp.exitCode).toBe(0);
		const r = await run(["view", "--html", "--sprouts"], root);
		expect(r.exitCode).toBe(0);
		const html = r.stdout;
		// No raw markup from prose anywhere.
		expect(html).not.toContain("<script>alert");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("onerror='");
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
		// Exactly one script: ours.
		expect(html.match(/<script>/g)?.length).toBe(1);
		// Self-contained: no external resources.
		expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
		expect(html).toContain("Content-Security-Policy");
		expect(html).toContain("<svg");
		expect(html).toContain('class="serves"');
		expect(html).toContain("Timeline (");
		expect(html).toContain("<b>plant</b>");
		expect(html).toContain('<div class="agent-zone">');
		expect(html).toContain('<span class="badge">[agent]</span>');
		expect(html).toMatch(/class="node agent"/);
	});
});
