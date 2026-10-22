// `luuna-roots view --html`: one self-contained static page. Inline CSS and JS,
// zero dependencies, no external requests (a CSP meta tag forbids them).
//
// Sections: an SVG graph (layered by serves depth: anchors on top, each idea
// one row below the lowest idea it serves), the document, and a timeline per
// idea from events.jsonl. Agent content (sprouts, agent questions, agent
// events) is labeled [agent] and dimmed.
//
// Safety: every piece of text from .luuna/roots/ goes through esc(). Prose is shown
// as escaped plain text (paragraphs, line breaks kept); it is never parsed as
// Markdown or HTML, so no human or agent text can inject markup or script.

import { endorsedLabel } from "./endorse.ts";
import type { EventRecord } from "./types.ts";
import type { ViewData, ViewIdea, ViewNode, ViewSprout } from "./view.ts";

export function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function statementOf(s: string): string {
	return s === "" ? "(empty)" : s;
}

function isAgent(by: unknown): boolean {
	return typeof by === "string" && by.startsWith("agent:");
}

// ── Layout ────────────────────────────────────────────────────────────────

export interface LayoutNode {
	id: string;
	label: string;
	x: number;
	y: number;
	agent: boolean;
}

export interface Layout {
	width: number;
	height: number;
	nodes: LayoutNode[];
}

const BOX_W = 150;
const BOX_H = 34;
const GAP_X = 24;
const ROW_H = 84;
const PAD = 20;

function truncate(s: string, max: number): string {
	const chars = [...s];
	return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Serves depth: 0 for ideas that serve nothing in the view, else 1 + max(target depth). */
export function servesDepths(d: ViewData): Map<string, number> {
	const targets = new Map<string, string[]>();
	for (const e of d.edges) {
		if (e.rel !== "serves") continue;
		targets.set(e.from, [...(targets.get(e.from) ?? []), e.to]);
	}
	const depth = new Map<string, number>();
	const visiting = new Set<string>();
	const of = (id: string): number => {
		const known = depth.get(id);
		if (known !== undefined) return known;
		if (visiting.has(id)) return 0; // corrupted graph with a cycle
		visiting.add(id);
		const ts = targets.get(id) ?? [];
		const v = ts.length === 0 ? 0 : 1 + Math.max(...ts.map(of));
		visiting.delete(id);
		depth.set(id, v);
		return v;
	};
	for (const id of Object.keys(d.ideas)) of(id);
	return depth;
}

export function layoutView(d: ViewData): Layout {
	const depths = servesDepths(d);
	const rows: { id: string; label: string; agent: boolean }[][] = [];
	for (const id of Object.keys(d.ideas)) {
		const row = depths.get(id) ?? 0;
		while (rows.length <= row) rows.push([]);
		rows[row]?.push({ id, label: d.ideas[id]?.slug ?? id, agent: false });
	}
	if (d.sprouts && d.sprouts.length > 0) {
		rows.push(d.sprouts.map((s) => ({ id: s.id, label: `[agent] ${s.slug}`, agent: true })));
	}
	const widest = Math.max(1, ...rows.map((r) => r.length));
	const width = PAD * 2 + widest * BOX_W + (widest - 1) * GAP_X;
	const nodes: LayoutNode[] = [];
	rows.forEach((row, r) => {
		const rowW = row.length * BOX_W + (row.length - 1) * GAP_X;
		const x0 = (width - rowW) / 2;
		row.forEach((n, i) => {
			nodes.push({ ...n, x: x0 + i * (BOX_W + GAP_X), y: PAD + r * ROW_H });
		});
	});
	return { width, height: PAD * 2 + Math.max(1, rows.length) * ROW_H - (ROW_H - BOX_H), nodes };
}

function edgeSvg(d: ViewData, pos: Map<string, LayoutNode>): string[] {
	const out: string[] = [];
	for (const e of d.edges) {
		const a = pos.get(e.from);
		const b = pos.get(e.to);
		if (!a || !b) continue;
		if (e.rel === "serves") {
			out.push(
				`<line class="serves" x1="${a.x + BOX_W / 2}" y1="${a.y}" x2="${b.x + BOX_W / 2}" y2="${b.y + BOX_H}" marker-end="url(#arrow)"/>`,
			);
		} else {
			const mx = (a.x + b.x) / 2 + BOX_W / 2;
			const my = Math.min(a.y, b.y) - 18;
			out.push(
				`<path class="tension" d="M${a.x + BOX_W / 2},${a.y} Q${mx},${my} ${b.x + BOX_W / 2},${b.y}"><title>tension</title></path>`,
			);
		}
	}
	return out;
}

function nodeSvg(n: LayoutNode, d: ViewData): string {
	const title = n.agent
		? (d.sprouts?.find((s) => s.id === n.id)?.statement ?? "")
		: (d.ideas[n.id]?.statement ?? "");
	return [
		`<a href="#${esc(n.id)}" class="node${n.agent ? " agent" : ""}" data-id="${esc(n.id)}">`,
		`<title>${esc(`${n.id}: ${statementOf(title)}`)}</title>`,
		`<rect x="${n.x}" y="${n.y}" width="${BOX_W}" height="${BOX_H}" rx="6"/>`,
		`<text x="${n.x + BOX_W / 2}" y="${n.y + BOX_H / 2 + 4}">${esc(truncate(n.label, 22))}</text>`,
		"</a>",
	].join("");
}

export function renderGraphSvg(d: ViewData): string {
	const layout = layoutView(d);
	const pos = new Map(layout.nodes.map((n) => [n.id, n]));
	return [
		`<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="Idea graph">`,
		'<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>',
		...edgeSvg(d, pos),
		...layout.nodes.map((n) => nodeSvg(n, d)),
		"</svg>",
	].join("\n");
}

// ── Document ──────────────────────────────────────────────────────────────

function proseHtml(text: string): string {
	if (text === "") return "";
	return text
		.split(/\n\s*\n/)
		.map((p) => `<p>${esc(p)}</p>`)
		.join("\n");
}

/** An endorsed idea's agent text: quoted and labeled, never shown as human prose. */
function endorsedHtml(i: ViewIdea): string {
	if (!i.endorsed) return "";
	const e = i.endorsed;
	const text = e.body ? `${e.statement}\n\n${e.body}` : e.statement;
	return [
		`<blockquote class="endorsed"><p class="by">${esc(endorsedLabel(e, i.author))}</p>`,
		proseHtml(text || "(sprout.md missing)"),
		"</blockquote>",
	].join("\n");
}

function blocksHtml(i: ViewIdea): string {
	return i.blocks
		.map((b) => {
			if (!b.question) return proseHtml(b.text);
			const q = b.question;
			const who = q.agent ? `[agent] ${q.by}` : q.by;
			const cls = q.agent ? "q agent" : "q";
			const label = `<p class="${cls}"><b>Q:</b> ${esc(q.text)} <span class="by">(<code>${esc(q.id)}</code> · ${esc(who)})</span></p>`;
			return `${label}\n${proseHtml(b.text)}`;
		})
		.join("\n");
}

function eventLine(e: EventRecord): string {
	const cls = isAgent(e.by) ? ' class="agent"' : "";
	const who = isAgent(e.by) ? `[agent] ${String(e.by)}` : String(e.by ?? "?");
	const when = String(e.at ?? "")
		.replace("T", " ")
		.replace(/Z$/, " UTC");
	return `<li${cls}><time>${esc(when)}</time> <b>${esc(String(e.type))}</b> <span class="by">${esc(who)}</span></li>`;
}

function timelineHtml(events: readonly EventRecord[]): string {
	if (events.length === 0) return "";
	return [
		`<details class="timeline"><summary>Timeline (${events.length})</summary><ol>`,
		...events.map(eventLine),
		"</ol></details>",
	].join("\n");
}

type Timelines = (id: string) => readonly EventRecord[];

function metaHtml(i: ViewIdea): string {
	return `<p class="meta"><code>${esc(i.id)}</code> · ${esc(i.slug)} · <span class="status s-${esc(i.status)}">${esc(i.status)}</span></p>`;
}

function nodeHtml(n: ViewNode, depth: number, tl: Timelines): string {
	if (n.ref) {
		return `<p class="ref">↑ Also serves this: <a href="#${esc(n.id)}">${esc(statementOf(n.statement))}</a> (<code>${esc(n.id)}</code>), shown above.</p>`;
	}
	const h = Math.min(2 + depth, 6);
	return [
		`<section class="idea" id="${esc(n.id)}" data-id="${esc(n.id)}">`,
		`<h${h}>${esc(statementOf(n.statement))}</h${h}>`,
		metaHtml(n),
		endorsedHtml(n),
		blocksHtml(n),
		timelineHtml(tl(n.id)),
		...n.children.map((c) => nodeHtml(c, depth + 1, tl)),
		"</section>",
	].join("\n");
}

function ideaLink(d: ViewData, id: string): string {
	const s = statementOf(d.ideas[id]?.statement ?? "");
	return `<a href="#${esc(id)}">${esc(s)}</a> (<code>${esc(id)}</code>)`;
}

function unanchoredHtml(d: ViewData, tl: Timelines): string {
	if (d.unanchored.length === 0) return "";
	return [
		"<h2>Not yet under an anchor</h2>",
		"<ul>",
		...d.unanchored.map(
			(i) =>
				`<li id="${esc(i.id)}" data-id="${esc(i.id)}">${esc(statementOf(i.statement))} (<code>${esc(i.id)}</code> · ${esc(i.status)})${timelineHtml(tl(i.id))}</li>`,
		),
		"</ul>",
	].join("\n");
}

function tensionsHtml(d: ViewData): string {
	if (d.tensions.length === 0) return "";
	return [
		"<h2>Tensions</h2>",
		"<ul>",
		...d.tensions.map((t) => `<li>${ideaLink(d, t.a)} ↔ ${ideaLink(d, t.b)}</li>`),
		"</ul>",
	].join("\n");
}

function questionsHtml(d: ViewData): string {
	if (d.questions.length === 0) return "";
	return [
		"<h2>Open questions</h2>",
		"<ul>",
		...d.questions.map((q) => {
			const cls = q.agent ? ' class="agent"' : "";
			const who = q.agent ? `[agent] ${q.by}` : q.by;
			return `<li${cls}><a href="#${esc(q.node)}"><code>${esc(q.node)}</code></a> ${esc(q.text)} <span class="by">(${esc(who)})</span></li>`;
		}),
		"</ul>",
	].join("\n");
}

function sproutHtml(s: ViewSprout): string {
	return [
		`<section class="sprout agent" id="${esc(s.id)}" data-id="${esc(s.id)}">`,
		`<h3><span class="badge">[agent]</span> ${esc(statementOf(s.statement))}</h3>`,
		`<p class="meta"><code>${esc(s.id)}</code> · ${esc(s.slug)} · proposed by ${esc(s.by)}</p>`,
		proseHtml(s.body),
		"</section>",
	].join("\n");
}

function sproutsHtml(d: ViewData): string {
	if (d.sprouts === null) return "";
	return [
		'<div class="agent-zone">',
		"<h2>Agent proposals (not accepted)</h2>",
		"<p><em>Written by agents. Not part of this project's intent unless a human adopts one in their own words.</em></p>",
		d.sprouts.length === 0 ? "<p>(no open sprouts)</p>" : "",
		...d.sprouts.map(sproutHtml),
		"</div>",
	].join("\n");
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1f2328;--muted:#6b6f76;--line:#d0d4da;--accent:#6b4fbb;--tension:#c2410c;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e6e6;--muted:#9aa0a6;--line:#3a3f47;--accent:#b69cff;--tension:#fb923c;--card:#1f2228}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.7rem;margin:0 0 4px}
.graph{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card);margin:16px 0 32px}
svg{display:block;margin:0 auto}
.endorsed{margin:8px 0;border-left:3px solid var(--line);padding-left:12px;color:var(--muted)}
svg .node rect{fill:var(--card);stroke:var(--accent);stroke-width:1.5}
svg .node text{fill:var(--fg);font-size:12px;text-anchor:middle}
svg .node.agent{opacity:.5}
svg .node.agent rect{stroke:var(--muted);stroke-dasharray:4 3}
svg .node.hot rect{stroke-width:3}
svg line.serves{stroke:var(--muted);stroke-width:1.2}
svg marker path{fill:var(--muted)}
svg path.tension{fill:none;stroke:var(--tension);stroke-width:1.5;stroke-dasharray:5 4}
section.idea{border-left:2px solid var(--line);padding-left:14px;margin:18px 0}
p{white-space:pre-wrap}
.meta{color:var(--muted);font-size:.85rem;margin-top:-6px}
.status{font-weight:600}
.ref{color:var(--muted);font-style:italic}
.q{color:var(--muted);border-left:3px solid var(--line);padding-left:10px;margin-bottom:4px}
code{font-size:.85em}
a{color:var(--accent)}
.timeline{font-size:.85rem;color:var(--muted);margin:6px 0}
.timeline ol{margin:4px 0;padding-left:20px}
.agent{opacity:.6}
.agent-zone{border:1px dashed var(--muted);border-radius:8px;padding:4px 16px;margin-top:32px;opacity:.75}
.agent-zone .agent{opacity:1}
.badge{font-size:.75em;color:var(--muted);border:1px solid var(--muted);border-radius:4px;padding:0 4px}
.by{color:var(--muted)}
.hot{outline:2px solid var(--accent);outline-offset:4px}
`;

// Hovering a section highlights its node in the graph and vice versa. Ids
// are compared as strings (no selector is built from data).
const JS = `
(function(){
  var all=[].slice.call(document.querySelectorAll('[data-id]'));
  function set(id,on){all.forEach(function(el){if(el.getAttribute('data-id')===id){el.classList.toggle('hot',on)}})}
  all.forEach(function(el){
    el.addEventListener('mouseenter',function(){set(el.getAttribute('data-id'),true)});
    el.addEventListener('mouseleave',function(){set(el.getAttribute('data-id'),false)});
  });
})();
`;

const CSP =
	"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

export function renderViewHtml(d: ViewData, timelines: Timelines): string {
	const title = d.from ? `${d.project}: intent from ${d.from}` : `${d.project}: intent`;
	const lines = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${esc(title)}</title>`,
		`<style>${CSS}</style>`,
		"</head>",
		"<body><main>",
		`<h1>${esc(title)}</h1>`,
		'<p class="meta">Generated by <code>luuna-roots view --html</code>. Human prose and human-accepted structure; agent content is marked [agent].</p>',
		`<div class="graph">${renderGraphSvg(d)}</div>`,
		d.tree.length === 0 ? "<p>(no committed or shaping ideas yet)</p>" : "",
		...d.tree.map((n) => nodeHtml(n, 0, timelines)),
		unanchoredHtml(d, timelines),
		tensionsHtml(d),
		questionsHtml(d),
		sproutsHtml(d),
		"</main>",
		`<script>${JS}</script>`,
		"</body></html>",
	];
	return `${lines.filter((l) => l !== "").join("\n")}\n`;
}
