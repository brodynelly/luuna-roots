// The one recommended next step, printed as a dim `next:` line after human
// commands (think, tend, adopt, plant, accept, reject) so the human never has
// to work out "now what?". Read-only and deterministic.
//
// Order: cards waiting in `tend` (proposals and sprouts) first, since agent
// work expires; then the idea most in need of thinking (attention.ts order),
// preferring one other than `exclude` (the idea just thought about); else
// plant something.

import { collectAttention, findingsReady, rankAttention } from "./attention.ts";
import { loadConfig } from "./config.ts";
import { readGraph } from "./graph.ts";
import type { Output } from "./output.ts";
import type { RootsPaths } from "./paths.ts";
import { scanNodeDirs } from "./prose.ts";
import type { TendCard } from "./tend.ts";
import { collectCards } from "./tend-session.ts";

export interface NextStep {
	command: string;
	reason: string;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function cardReason(cards: readonly TendCard[]): string {
	const sprouts = cards.filter((c) => c.type === "sprout").length;
	const proposals = cards.length - sprouts;
	const parts = [
		sprouts ? plural(sprouts, "sprout") : "",
		proposals ? plural(proposals, "proposal") : "",
	].filter(Boolean);
	return `${parts.join(", ")} waiting for review`;
}

export function nextStep(paths: RootsPaths, now: Date, exclude?: string): NextStep {
	const cards = collectCards(paths, now);
	if (cards.length > 0) return { command: "luuna-roots tend", reason: cardReason(cards) };
	const graph = readGraph(paths);
	const ranked = rankAttention(
		collectAttention(paths, graph, scanNodeDirs(paths), loadConfig(paths), now),
	);
	const pick = ranked.find((a) => a.node.id !== exclude) ?? ranked[0];
	if (pick) {
		const open = pick.due.length;
		const why = findingsReady(pick)
			? "agent findings ready"
			: open
				? plural(open, "open question")
				: plural(pick.candidates.length, "new question");
		return { command: `luuna-roots think ${pick.node.id}`, reason: `${pick.node.slug}: ${why}` };
	}
	return { command: 'luuna-roots plant "<one sentence>"', reason: "nothing needs thinking" };
}

/** Print the `next:` line (human mode only; never fails the command). */
export async function printNext(
	out: Output,
	paths: RootsPaths,
	opts: { exclude?: string; now?: Date } = {},
): Promise<void> {
	if (out.json || out.quiet) return;
	let step: NextStep;
	try {
		step = nextStep(paths, opts.now ?? new Date(), opts.exclude);
	} catch {
		return;
	}
	await out.info(out.c.dim(`next: ${step.command} — ${step.reason}`));
}
