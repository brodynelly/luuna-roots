// The flow transition card (roots-3ad0). Pure: FlowCard + frame info in,
// lines out. Same box and helpers as the think screen.
//
//   ┌─ luuna-roots flow ── warren ── 23m ── inbox 3 ──────────┐
//   │ trail                                             │
//   │   r-c818 team-agent-platform  3 answered  shaping │
//   │ ── heading ── [agent] ─────────────── [x] dismiss │
//   │ ...                                               │
//   │ [enter] review inbox (3)                          │
//   │ [n] next: r-c818 · 1 open question ← heading      │
//   └───────────────────────────────────────────────────┘

import type { Colors } from "./color.ts";
import { currentPick, enterAction, type FlowCard, type FlowTrail } from "./flow.ts";
import { truncate } from "./format.ts";
import { divider, fit, type Seg, screenWidth, wrapText } from "./think-screen.ts";

export interface FlowFrame {
	project: string;
	/** Minutes since the flow started. */
	minutes: number;
}

/** `limit` caps the entry rows; older entries fold into one "… N earlier" row. */
function trailRows(t: FlowTrail, inner: number, c: Colors, limit = Infinity): Seg[][] {
	const rows: Seg[][] = [[{ t: "trail", s: c.bold }]];
	if (t.entries.length === 0) {
		rows.push([{ t: "  nothing yet: pick an idea below", s: c.dim }]);
		return rows;
	}
	const cols = t.entries.map((e) => ({
		e,
		counts: [`${e.answered} answered`, e.open ? `${e.open} open` : ""].filter(Boolean).join(" · "),
	}));
	const countWidth = Math.max(...cols.map((x) => x.counts.length));
	const statusWidth = Math.max(...t.entries.map((e) => e.status.length));
	const shown = limit < cols.length ? cols.slice(cols.length - Math.max(1, limit - 1)) : cols;
	const hidden = cols.length - shown.length;
	if (hidden > 0) rows.push([{ t: `  … ${hidden} earlier`, s: c.dim }]);
	for (const { e, counts } of shown) {
		const mark = e.id === t.current ? "  ← last" : "";
		const tail = `  ${counts.padEnd(countWidth)}  ${e.status.padEnd(statusWidth)}${mark}`;
		const room = Math.max(4, inner - 2 - e.id.length - 1 - (tail.length - mark.length) - 8);
		rows.push([
			{ t: "  " },
			{ t: e.id, s: c.id },
			{ t: ` ${truncate(e.slug, room).padEnd(room)}` },
			{ t: tail, s: c.dim },
		]);
	}
	const extra = [
		t.adopted.length ? `adopted ${t.adopted.join(", ")}` : "",
		t.planted.length ? `planted ${t.planted.join(", ")}` : "",
		t.accepted ? `accepted ${t.accepted}` : "",
		t.rejected ? `rejected ${t.rejected}` : "",
	].filter(Boolean);
	if (extra.length) rows.push([{ t: `  + ${extra.join(" · ")}`, s: c.dim }]);
	return rows;
}

function headingRows(card: FlowCard, inner: number, c: Colors): Seg[][] {
	const h = card.heading;
	if (h.kind === "off") return [];
	if (h.kind !== "shown") {
		const text = h.kind === "waiting" ? "the agent is reading your session…" : "(no heading yet)";
		return [[], divider("heading", "agent", inner, c), [{ t: text, s: c.dim }]];
	}
	const label = "── heading ── [agent] ";
	const tail = " [x] dismiss ──";
	const fill = "─".repeat(Math.max(0, inner - label.length - tail.length));
	return [
		[],
		[
			{ t: label + fill, s: c.dim },
			{ t: tail, s: c.dim },
		],
		...wrapText(h.heading.text, inner).map((t) => [{ t }]),
	];
}

function statusRows(card: FlowCard, inner: number, c: Colors): Seg[][] {
	const rows: Seg[][] = [];
	if (card.jobs.length > 0) {
		rows.push([{ t: `… ${card.jobs.join(" · ")}`, s: c.dim }]);
	}
	if (card.notice) {
		const bad = card.notice.startsWith("! ");
		const text = bad ? card.notice : `✓ ${card.notice}`;
		rows.push(...wrapText(text, inner).map((t) => [{ t, s: bad ? c.yellow : c.green }]));
	}
	return rows.length > 0 ? [[], ...rows] : [];
}

function key(k: string, label: string, c: Colors, note?: string): Seg[] {
	return [
		{ t: `[${k}]`, s: c.cyan },
		{ t: ` ${label}` },
		...(note ? [{ t: ` ${note}`, s: c.yellow }] : []),
	];
}

function keyRows(card: FlowCard, inner: number, c: Colors): Seg[][] {
	const rows: Seg[][] = [];
	const enter = enterAction(card);
	const pick = currentPick(card);
	if (enter?.type === "tend") rows.push(key("enter", `review inbox (${card.inbox})`, c));
	if (pick) {
		const k = enter?.type === "think" ? "enter" : "n";
		const verb = enter?.type === "think" ? "think" : "next";
		const note = pick.fromHeading ? "← heading" : undefined;
		const fixed = `[${k}] ${verb}: ${pick.id}  · ${pick.reason}${note ? ` ${note}` : ""}`;
		const slug = truncate(pick.slug, Math.max(4, inner - fixed.length));
		rows.push(key(k, `${verb}: ${pick.id} ${slug} · ${pick.reason}`, c, note));
		if (card.picks.length > 1) rows.push(key("o", `other idea (${card.picks.length - 1} more)`, c));
	}
	const last: Seg[] = [...key("p", "plant", c), { t: "   " }];
	if (card.heading.kind === "shown") last.push(...key("x", "dismiss heading", c), { t: "   " });
	last.push(...key("q", "end flow", c));
	if (!pick && card.inbox === 0) rows.push(key("enter", "plant an idea", c));
	rows.push(last);
	return rows;
}

/**
 * Draw the card. With `rows` it is exactly that tall: blank space goes above
 * the keys so they sit at the bottom, and a card taller than the terminal
 * folds older trail entries, then drops rows below the trail, so the frame
 * never scrolls its top border off-screen.
 */
export function renderFlowCard(
	card: FlowCard,
	f: FlowFrame,
	columns: number,
	c: Colors,
	rows = 0,
): string[] {
	const width = screenWidth(columns);
	const inner = width - 4;
	const keys = keyRows(card, inner, c);
	const rest = [...headingRows(card, inner, c), ...statusRows(card, inner, c), []];
	let trail = trailRows(card.trail, inner, c);
	const room = rows > 0 ? Math.max(0, rows - keys.length - 2) : Infinity;
	if (trail.length + rest.length > room) {
		// Header + (limit) entry rows + adopted/planted line must fit beside `rest`.
		const extra = trail.length - 1 - card.trail.entries.length;
		const limit = Math.max(1, room - rest.length - 1 - extra);
		trail = trailRows(card.trail, inner, c, limit);
	}
	const content = [...trail, ...rest].slice(0, room);
	const inbox = card.inbox > 0 ? ` ── inbox ${card.inbox}` : "";
	const title = truncate(` luuna-roots flow ── ${f.project} ── ${f.minutes}m${inbox} `, width - 4);
	const top = `┌─${title}${"─".repeat(Math.max(0, width - 3 - [...title].length))}┐`;
	const spare = Math.max(0, rows - (content.length + keys.length + 2));
	const filler: Seg[][] = Array.from({ length: spare }, () => []);
	const body = [...content, ...filler, ...keys].map((r) => `│ ${fit(r, inner)} │`);
	return [c.dim(top), ...body, c.dim(`└${"─".repeat(width - 2)}┘`)];
}
