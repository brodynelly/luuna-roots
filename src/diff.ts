// Line-level diffs between two versions of a prose file. Pure.

export interface DiffSpan {
	/** First changed line in the new text (1-based). */
	from: number;
	/** Last changed line in the new text; `from - 1` for a pure deletion. */
	to: number;
	/** How many old lines were replaced or removed. */
	removed: number;
}

export function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * The one contiguous span that covers every change: common prefix and suffix
 * lines are trimmed. Null when the texts have the same lines.
 */
export function diffSpan(before: string, after: string): DiffSpan | null {
	const a = splitLines(before);
	const b = splitLines(after);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}
	const removed = a.length - prefix - suffix;
	const added = b.length - prefix - suffix;
	if (removed === 0 && added === 0) return null;
	return { from: prefix + 1, to: prefix + added, removed };
}

export interface ChangedLine {
	/** 1-based line number in the new text. */
	line: number;
	text: string;
}

/**
 * Non-blank lines of `after` that are not in `before` (multiset: a line that
 * appears twice now but once before counts once). Used for mention detection.
 */
export function changedLines(before: string, after: string): ChangedLine[] {
	const pool = new Map<string, number>();
	for (const l of splitLines(before)) pool.set(l, (pool.get(l) ?? 0) + 1);
	const out: ChangedLine[] = [];
	splitLines(after).forEach((text, i) => {
		const left = pool.get(text) ?? 0;
		if (left > 0) {
			pool.set(text, left - 1);
			return;
		}
		if (text.trim() !== "") out.push({ line: i + 1, text });
	});
	return out;
}

/** Every non-blank line of `text` (for `luuna-roots scan`, which has no "before"). */
export function allLines(text: string): ChangedLine[] {
	return changedLines("", text);
}

export function formatSpan(span: DiffSpan): string {
	if (span.to < span.from) return `deleted ${span.removed} line${span.removed === 1 ? "" : "s"}`;
	return span.from === span.to ? `line ${span.from}` : `lines ${span.from}–${span.to}`;
}
