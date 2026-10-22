// The left-pane think screen (roots-b0ea). Pure: takes a
// view model, returns lines. Raw ANSI via Colors (NO_COLOR respected).

import type { Colors } from "./color.ts";
import { EDGE_LABEL_WIDTH, type EdgeDirection, edgeLabel, truncate } from "./format.ts";
import type { EdgeRel, NodeStatus } from "./types.ts";

export interface ScreenEdge {
	rel: EdgeRel;
	direction: EdgeDirection;
	id: string;
	slug: string;
}

export interface ScreenFinding {
	/** First paragraph of the agent's findings note. */
	text: string;
	path: string;
}

export interface ScreenQuestion {
	/** Question id (q-xxxx), so the human can cite it to an agent or `roots` command. */
	id: string;
	text: string;
	/** The agent's research on a delegated question, shown under it. */
	findings?: ScreenFinding | null;
	/** Rule name, `agent`, or another source label. */
	source: string;
	/** 1-based position and total. */
	index: number;
	total: number;
}

export interface ScreenView {
	id: string;
	slug: string;
	status: NodeStatus;
	statement: string;
	edges: ScreenEdge[];
	question: ScreenQuestion | null;
	notice: string | null;
	/** Where the idea file is being edited. */
	editorHint: string;
	/** [a] is offered (agents may work on this idea). */
	canDelegate?: boolean;
	/** Shown above the question, e.g. an accepted split proposal (agent text, dimmed). */
	guidance?: ScreenGuidance | null;
}

export interface ScreenGuidance {
	/** Divider label, e.g. "split p-3b21". */
	label: string;
	source: string;
	text: string;
}

export interface Seg {
	t: string;
	s?: (x: string) => string;
}

export const MIN_WIDTH = 32;
export const MAX_WIDTH = 100;

function wrapPara(para: string, width: number): string[] {
	const lines: string[] = [];
	let cur = "";
	for (const word of para.split(/\s+/).filter(Boolean)) {
		const chars = [...word];
		for (let i = 0; i < chars.length; i += width) {
			const piece = chars.slice(i, i + width).join("");
			const next = cur ? `${cur} ${piece}` : piece;
			if ([...next].length <= width) {
				cur = next;
				continue;
			}
			if (cur) lines.push(cur);
			cur = piece;
		}
	}
	lines.push(cur);
	return lines;
}

/** Word-wrap plain text; words longer than `width` are hard-broken. */
export function wrapText(text: string, width: number): string[] {
	return text.split("\n").flatMap((p) => wrapPara(p, width));
}

/** Fit styled segments into exactly `width` visible columns. */
export function fit(segs: readonly Seg[], width: number): string {
	let used = 0;
	let out = "";
	for (const seg of segs) {
		const room = width - used;
		if (room <= 0) break;
		const len = [...seg.t].length;
		const t = len > room ? truncate(seg.t, room) : seg.t;
		used += Math.min(len, room);
		out += seg.s ? seg.s(t) : t;
	}
	return out + " ".repeat(Math.max(0, width - used));
}

function header(v: ScreenView, inner: number, c: Colors): Seg[] {
	// Status stays visible; the slug gives way on narrow panes.
	const room = Math.max(1, inner - v.id.length - v.status.length - 4);
	const slug = truncate(v.slug, room);
	const gap = Math.max(2, inner - v.id.length - 2 - [...slug].length - v.status.length);
	return [
		{ t: v.id, s: (x) => c.id(c.bold(x)) },
		{ t: `  ${slug}` },
		{ t: " ".repeat(gap) },
		{ t: v.status, s: c.cyan },
	];
}

function edgeRows(v: ScreenView, c: Colors): Seg[][] {
	if (v.edges.length === 0) return [[{ t: "(no links yet)", s: c.dim }]];
	return v.edges.map((e) => {
		const { label, arrow } = edgeLabel(e.rel, e.direction);
		return [
			{ t: `${label.padEnd(EDGE_LABEL_WIDTH)}${arrow} ` },
			{ t: e.id, s: c.id },
			{ t: ` ${e.slug}` },
		];
	});
}

export function divider(label: string, source: string | null, inner: number, c: Colors): Seg[] {
	const head = `── ${label} ──${source ? ` [${source}] ` : " "}`;
	return [{ t: head + "─".repeat(Math.max(0, inner - [...head].length)), s: c.dim }];
}

function questionRows(v: ScreenView, inner: number, c: Colors): Seg[][] {
	const q = v.question;
	if (!q) {
		return [
			divider("no questions", null, inner, c),
			...wrapText("Nothing to ask right now. Write freely; saves are kept.", inner).map((t) => [
				{ t, s: c.dim },
			]),
		];
	}
	return [
		divider(`question ${q.index}/${q.total} · ${q.id}`, q.source, inner, c),
		...wrapText(q.text, inner).map((t) => [{ t, s: c.bold }]),
		...findingRows(q.findings ?? null, inner, c),
	];
}

const FINDING_LINES = 5;

function findingRows(f: ScreenFinding | null, inner: number, c: Colors): Seg[][] {
	if (!f) return [];
	let lines = wrapText(f.text, inner);
	if (lines.length > FINDING_LINES) {
		lines = [
			...lines.slice(0, FINDING_LINES - 1),
			truncate(`${lines[FINDING_LINES - 1]} …`, inner),
		];
	}
	return [
		[],
		divider("findings", "agent", inner, c),
		...lines.map((t) => [{ t, s: c.dim }]),
		[{ t: truncate(`full: ${f.path}`, inner), s: c.dim }],
	];
}

function guidanceRows(v: ScreenView, inner: number, c: Colors): Seg[][] {
	const g = v.guidance;
	if (!g) return [];
	return [
		divider(g.label, g.source, inner, c),
		...wrapText(g.text, inner).map((t) => [{ t, s: c.dim }]),
		[],
	];
}

const KEY_GAP = 2;

/**
 * Column widths when `cells` are laid out row-major, `cols` per row. The last
 * cell of each row does not widen its column (nothing follows it).
 */
function columnWidths(cells: readonly string[], cols: number): number[] {
	const widths = new Array<number>(cols).fill(0);
	cells.forEach((cell, i) => {
		const lastInRow = i % cols === cols - 1 || i === cells.length - 1;
		if (!lastInRow) widths[i % cols] = Math.max(widths[i % cols] ?? 0, cell.length);
	});
	return widths;
}

function gridWidth(cells: readonly string[], widths: readonly number[]): number {
	let max = 0;
	cells.forEach((cell, i) => {
		const col = i % widths.length;
		const offset = widths.slice(0, col).reduce((a, b) => a + b + KEY_GAP, 0);
		max = Math.max(max, offset + cell.length);
	});
	return max;
}

/** The widest grid (at most 3 per row) that fits. */
function keyGrid(cells: readonly string[], inner: number): number[] {
	for (let cols = Math.min(3, cells.length); cols > 1; cols--) {
		const widths = columnWidths(cells, cols);
		if (gridWidth(cells, widths) <= inner) return widths;
	}
	return [0];
}

/** Keybind hints in aligned columns that fit `inner`. */
function keyRows(v: ScreenView, inner: number, c: Colors): Seg[][] {
	const keys: Array<[string, string]> = v.question
		? [
				["save", "answer"],
				["d", "dismiss"],
				["z", "snooze"],
				["s", "skip"],
				...(v.canDelegate ? [["a", "ask agent"] as [string, string]] : []),
				["q", "end session"],
			]
		: [["q", "end session"]];
	const widths = keyGrid(
		keys.map(([k, l]) => `[${k}] ${l}`),
		inner,
	);
	const rows: Seg[][] = [];
	keys.forEach(([key, label], i) => {
		const col = i % widths.length;
		if (col === 0) rows.push([]);
		const last = col === widths.length - 1 || i === keys.length - 1;
		const pad = last ? 0 : (widths[col] ?? 0) + KEY_GAP - (key.length + label.length + 3);
		rows[rows.length - 1]?.push({ t: `[${key}]`, s: c.cyan }, { t: ` ${label}${" ".repeat(pad)}` });
	});
	return rows;
}

export function screenWidth(columns: number): number {
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns));
}

/**
 * Draw the screen. With `rows` (terminal height), the box grows to fill it:
 * blank rows go above the notice and keys, so they sit at the bottom. It
 * never grows past `rows`: edges fold first, then the bottom of the content
 * is cut, so the title border never scrolls off-screen.
 */
export function renderScreen(v: ScreenView, columns: number, c: Colors, rows = 0): string[] {
	const width = screenWidth(columns);
	const inner = width - 4;
	const statement = truncate(`"${v.statement || "(empty)"}"`, inner);
	const edges = edgeRows(v, c);
	const rest = [[], ...guidanceRows(v, inner, c), ...questionRows(v, inner, c), []];
	let content: Seg[][] = [header(v, inner, c), [{ t: statement }], [], ...edges, ...rest];
	const footer: Seg[][] = [
		v.notice ? [{ t: `✓ ${v.notice}`, s: c.green }] : [],
		...keyRows(v, inner, c),
	];
	const title = truncate(` luuna-roots think ${v.slug} `, width - 4);
	const top = `┌─${title}${"─".repeat(Math.max(0, width - 3 - [...title].length))}┐`;
	const hint = wrapText(v.editorHint, width - 2).map((l) => ` ${c.dim(l)}`);
	const room = rows > 0 ? Math.max(0, rows - footer.length - 2 - hint.length) : Infinity;
	if (content.length > room && v.edges.length > 1) {
		const folded: Seg[][] = [[{ t: `${v.edges.length} links (terminal too short)`, s: c.dim }]];
		content = [header(v, inner, c), [{ t: statement }], [], ...folded, ...rest];
	}
	content = content.slice(0, room);
	const spare = Math.max(0, rows - (content.length + footer.length + 2 + hint.length));
	const filler: Seg[][] = Array.from({ length: spare }, () => []);
	const body = [...content, ...filler, ...footer].map((r) => `│ ${fit(r, inner)} │`);
	const bottom = `└${"─".repeat(width - 2)}┘`;
	return [c.dim(top), ...body, c.dim(bottom), ...hint];
}
