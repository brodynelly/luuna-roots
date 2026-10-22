// `luuna-roots tend`, pure renderer: draws the current card as a box (roots-9c29). Split out of tend.ts (cards + reducer).

import type { Colors } from "./color.ts";
import { edgeLabel, truncate } from "./format.ts";
import {
	cardKeys,
	currentCard,
	daysLeft,
	expiringSoon,
	type ProposalCard,
	type SproutCard,
	type TendCard,
	type TendState,
} from "./tend.ts";
import { wrapText } from "./think-screen.ts";
import type { Actor } from "./types.ts";

export const CARD_MIN_WIDTH = 40;
export const CARD_MAX_WIDTH = 100;

function sourceLabel(sources: readonly Actor[]): string {
	return sources
		.map((s) => (s.startsWith("agent:") ? `[agent] ${s.slice("agent:".length)}` : s))
		.map((s) => (s === "roots:mention" ? "mention" : s))
		.join(" + ");
}

function relationLine(card: ProposalCard): string {
	const a = card.from.slug;
	const b = card.to?.slug ?? "";
	if (card.kind === "edge") {
		if (!card.rel) return `${a}  ─?─  ${b}`;
		const { label, arrow } = edgeLabel(card.rel, "out");
		return `${a}  ${arrow} ${label} ${arrow}  ${b}`;
	}
	if (card.kind === "merge") return `merge  ${a}  ⇄  ${b}`;
	return `${card.kind}  ${a}`;
}

function sproutBody(card: SproutCard, inner: number, c: Colors): string[] {
	const lines = wrapText(card.statement || "(empty)", inner).map((l) => c.bold(l));
	// The whole body: the human decides on what the agent actually wrote.
	// renderTend clamps it to the terminal height.
	const body = card.body.split("\n").filter((l) => l.trim() !== "");
	if (body.length > 0) lines.push("", ...body.flatMap((l) => wrapText(l, inner)));
	const hint =
		"[t] keeps this as the agent's text, quoted, plus your thoughts · [y] you rewrite it (nothing copied)";
	lines.push("", ...wrapText(hint, inner).map((l) => c.dim(l)));
	return lines;
}

function cardBody(card: TendCard, inner: number, c: Colors): string[] {
	if (card.type === "sprout") return sproutBody(card, inner, c);
	return proposalBody(card, inner, c);
}

function proposalBody(card: ProposalCard, inner: number, c: Colors): string[] {
	const rel = relationLine(card);
	const relLines = [...rel].length <= inner ? [rel] : wrapText(rel, inner);
	const lines = [...relLines.map((l) => c.bold(l)), ""];
	if (card.reason) lines.push(...wrapText(`"${card.reason}"`, inner));
	for (const n of card.notes) lines.push(...wrapText(n, inner).map((l) => c.dim(l)));
	for (const cite of card.cites) {
		lines.push(...wrapText(`${cite.node}: "${cite.quote}"`, inner - 2).map((l) => `  ${l}`));
	}
	if (card.pickRel && card.rel) lines.push("", c.dim(`suggested: ${card.rel}; or pick one`));
	return lines;
}

function keyLines(card: TendCard, inner: number, c: Colors): string[] {
	const cells = cardKeys(card).map((k) => ({
		plain: `[${k.key}] ${k.label}`,
		key: k.key,
		label: k.label,
	}));
	const rows: string[] = [];
	let cur = "";
	let used = 0;
	for (const cell of cells) {
		const w = cell.plain.length;
		if (used > 0 && used + 2 + w > inner) {
			rows.push(cur);
			cur = "";
			used = 0;
		}
		cur += `${used > 0 ? "  " : ""}${c.cyan(`[${cell.key}]`)} ${cell.label}`;
		used += (used > 0 ? 2 : 0) + w;
	}
	if (cur) rows.push(cur);
	return rows;
}

function visible(s: string): number {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI to measure
	return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

function boxLine(content: string, inner: number): string {
	const len = visible(content);
	const text = len > inner ? truncate(content, inner) : content;
	return `│ ${text}${" ".repeat(Math.max(0, inner - visible(text)))} │`;
}

function header(card: TendCard, now: Date, width: number, c: Colors): string {
	const days = daysLeft(card.expiresAt, now);
	const head = card.type === "sprout" ? `sprout ${card.id}` : `proposal ${card.ids.join(" + ")}`;
	const sources = card.type === "sprout" ? [card.author] : card.sources;
	const tail = days === null ? "" : ` ── expires in ${days}d`;
	// The sources give way first on narrow screens; the id and expiry stay.
	const room = width - 8 - [...head].length - [...tail].length - 4;
	const src = room > 3 ? ` ── ${truncate(sourceLabel(sources), room)}` : "";
	const title = truncate(` ${head}${src}${tail} `, width - 4);
	const fill = "─".repeat(Math.max(0, width - 3 - [...title].length));
	const colored = expiringSoon(card, now) ? c.yellow(title) : title;
	return `${c.dim("┌─")}${colored}${c.dim(`${fill}┐`)}`;
}

export interface TendView {
	state: TendState;
	now: Date;
	/** Proposals expired at the start of this tend run. */
	expired: number;
	/** Sprouts expired at the start of this tend run. */
	expiredSprouts?: number;
}

/** Cut a body taller than `room` rows, ending with "… N more lines". */
function clampBody(body: string[], room: number, c: Colors): string[] {
	if (body.length <= room) return body;
	const keep = Math.max(1, room - 1);
	const more = body.length - keep;
	return [...body.slice(0, keep), c.dim(`… ${more} more line${more === 1 ? "" : "s"}`)];
}

/**
 * Draw the current card. With `rows` (terminal height), the card grows to
 * fill it: blank rows go above the keys, so keys and status sit at the bottom.
 * A body taller than the terminal is cut with "… N more lines" so the header
 * never scrolls off-screen.
 */
export function renderTend(v: TendView, columns: number, c: Colors, rows = 0): string[] {
	const width = Math.max(CARD_MIN_WIDTH, Math.min(CARD_MAX_WIDTH, columns));
	const inner = width - 4;
	const card = currentCard(v.state);
	const top = [c.bold(`luuna-roots tend`) + c.dim(`  card ${v.state.index + 1}/${v.state.cards.length}`)];
	if (v.expired > 0) top.push(c.dim(`${v.expired} proposal${v.expired === 1 ? "" : "s"} expired`));
	const es = v.expiredSprouts ?? 0;
	if (es > 0) top.push(c.dim(`${es} sprout${es === 1 ? "" : "s"} expired`));
	if (!card) return top;
	let content = cardBody(card, inner, c);
	const keys = ["", ...keyLines(card, inner, c)];
	const s = v.state;
	const footer: string[] = [];
	if (s.reason !== null) footer.push(`reason: ${s.reason}█`, c.dim("[enter] reject  [esc] cancel"));
	if (s.thoughts !== null) {
		footer.push(
			...wrapText(`thoughts: ${s.thoughts}█`, width),
			c.dim("[enter] accept with thoughts  [ctrl-e] continue in $EDITOR  [esc] cancel"),
		);
	}
	if (s.busy) footer.push(c.dim("working…"));
	if (s.error) footer.push(c.red(`! ${s.error}`));
	else if (s.notice) footer.push(c.green(`✓ ${s.notice}`));
	footer.push(c.dim("[q] quit"));
	const fixed = top.length + 1 + 2 + keys.length + footer.length;
	if (rows > 0) content = clampBody(content, rows - fixed, c);
	const used = fixed + content.length;
	const filler = Array.from({ length: Math.max(0, rows - used) }, () => "");
	return [
		...top,
		"",
		header(card, v.now, width, c),
		...[...content, ...filler, ...keys].map((l) => boxLine(l, inner)),
		c.dim(`└${"─".repeat(width - 2)}┘`),
		...footer,
	];
}
