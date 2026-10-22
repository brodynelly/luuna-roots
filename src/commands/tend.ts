// luuna-roots tend (human, TTY): review pending proposals one card at a time.
// `luuna-roots tend --json` lists the cards without a TTY and without deciding
// (or expiring) anything.

import { flagBool } from "../args.ts";
import { colorEnabled, makeColors } from "../color.ts";
import { GuardError } from "../errors.ts";
import { requireHumanCommand, requireTty } from "../guard.ts";
import type { Io } from "../io.ts";
import { printNext } from "../next.ts";
import type { Output } from "../output.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { daysLeft, expiringSoon, type TendCard } from "../tend.ts";
import { collectCards, runTend, type TendSummary, type ThinkRunner } from "../tend-session.ts";
import type { Actor } from "../types.ts";
import { openWorkspace } from "../workspace.ts";
import { decisionLines } from "./accept.ts";
import { runAdoption } from "./adopt.ts";
import { startThink, tallyLine } from "./think.ts";

export function thinkRunner(io: Io, by: Actor, split: boolean): ThinkRunner {
	return async (id, guidance) => {
		const ws = await openWorkspace(io.cwd);
		const node = resolveNode(ws.graph.nodes, id, { kind: "idea" });
		const run = await startThink(io, ws, node, {
			by,
			split,
			guidance: { label: "split this idea", source: "agent, accepted", text: guidance },
		});
		return `think session ${run.summary.session} on ${node.slug}: ${tallyLine(run.summary)}`;
	};
}

function cardLine(out: Output, c: TendCard): string {
	if (c.type === "sprout") {
		return `${out.c.id(c.id)} sprout ${c.slug}: ${c.statement}  ${out.c.dim(c.author)}`;
	}
	const pair = c.to ? `${c.from.slug} ─${c.rel ?? "?"}─ ${c.to.slug}` : c.from.slug;
	return `${out.c.id(c.ids.join("+"))} ${c.kind} ${pair}  ${out.c.dim(c.sources.join(", "))}`;
}

async function listCards(io: Io, out: Output): Promise<void> {
	const ws = await openWorkspace(io.cwd);
	const now = new Date();
	const cards = collectCards(ws.paths, now).map((c) => ({
		...c,
		expiresInDays: daysLeft(c.expiresAt, now),
		expiringSoon: expiringSoon(c, now),
	}));
	await out.result({ cards });
	for (const c of cards) await out.line(cardLine(out, c));
	if (cards.length === 0) await out.line("Nothing to tend.");
}

/** One line for a finished tend pass (flow shows it on its card). */
export function tendLine(s: TendSummary): string {
	if (s.cards === 0) return "nothing to tend";
	const t = s.tally;
	return `tended ${s.cards}: ${t.accepted} accepted, ${t.rejected} rejected, ${t.skipped} skipped`;
}

async function printSummary(out: Output, s: TendSummary): Promise<void> {
	const c = out.c;
	if (s.expired.length > 0) {
		await out.info(c.dim(`${s.expired.length} proposal(s) expired unreviewed`));
	}
	if (s.expiredSprouts.length > 0) {
		await out.info(c.dim(`${s.expiredSprouts.length} sprout(s) expired unreviewed`));
	}
	if (s.cards === 0) return out.line("Nothing to tend.");
	for (const d of s.decisions) await out.lines(decisionLines(out, d));
	const t = s.tally;
	const parts = [
		`${t.accepted} accepted`,
		`${t.rejected} rejected`,
		`${t.skipped} skipped`,
		t.left ? `${t.left} left` : "",
	].filter(Boolean);
	await out.success(`tended ${s.cards} card${s.cards === 1 ? "" : "s"}: ${parts.join(", ")}`);
}

export const tendCommand: CommandDef = {
	name: "tend",
	group: "structure",
	summary: "Interactive review: proposals, sprouts, expiring items",
	usage: "tend",
	description:
		"One card per proposal (a mention and an agent proposal for the same pair share a\n" +
		"card), soonest expiry first. Keys: [y] accept  [n] reject  [r] reject with a reason\n" +
		"[s] skip  [q] quit. Mention cards: [1] serves [2] tension [3] replaces. Merge cards:\n" +
		"[1]/[2] pick the idea that survives. Accepting a split opens a think session on the\n" +
		"idea with the split shown as guidance. Sprout cards: [y] adopts it (you write the\n" +
		"idea yourself in $EDITOR; nothing is copied), [n]/[r] reject it for good.\n" +
		"--json lists the cards and decides nothing.",
	flags: {
		"no-split": {
			type: "boolean",
			description: "No split panes (think after a split; the sprout while adopting)",
		},
	},
	maxArgs: 0,
	async run({ io, out, flags }) {
		if (out.json) return listCards(io, out);
		requireTty(io, "tend");
		const by = requireHumanCommand(io, "tend");
		const terminal = io.terminal;
		if (!terminal) throw new GuardError("`luuna-roots tend` needs an interactive terminal");
		const ws = await openWorkspace(io.cwd);
		const summary = await runTend({
			paths: ws.paths,
			by,
			terminal,
			colors: makeColors(colorEnabled(io.env, true)),
			think: thinkRunner(io, by, !flagBool(flags, "no-split")),
			adopt: (id, endorse) =>
				runAdoption(io, ws.paths, id, { by, split: !flagBool(flags, "no-split"), endorse }),
		});
		await printSummary(out, summary);
		await printNext(out, ws.paths);
	},
};
