// luuna-roots drift [--diff <rev>] (agent-facing, read-only; tier 3): a context
// packet of the ideas a repo change touches, so an agent can `luuna-roots ask
// <id> "does this still hold?"`. Run by the tier-3 Claude Code Stop hook
// (`luuna-roots drift --diff HEAD`), so it must never block or fail a session:
// outside a roots project, below project tier 3, or when git fails it
// prints nothing and exits 0 (`--json` says why in `skipped`). With nothing
// touched it also prints nothing. It never writes (not even the directory
// fix-up `openWorkspace` does). Matching rules: src/drift.ts.

import { flagString } from "../args.ts";
import { loadConfig } from "../config.ts";
import {
	DRIFT_TIER,
	type DriftCommit,
	type DriftHit,
	driftIdeas,
	gatherDrift,
	ideaFile,
	matchDrift,
} from "../drift.ts";
import { readClaim } from "../endorse.ts";
import { readGraph } from "../graph.ts";
import type { Io } from "../io.ts";
import type { Output } from "../output.ts";
import { findProjectRoot, rootsPaths } from "../paths.ts";
import { scanNodeDirs } from "../prose.ts";
import type { CommandDef } from "../registry.ts";
import { readSeedsIssues } from "../seeds-link.ts";

export const DRIFT_INSTRUCTION =
	"For each idea below, check whether the change still fits it. If it may not, ask the " +
	'human one specific question: luuna-roots ask <id> "<question>?" --as agent:<model>. ' +
	"If the change clearly fits, do nothing. Never edit .luuna/roots/human/.";

const SHOWN_FILES = 20;

interface DriftIdea {
	id: string;
	slug: string;
	status: string;
	statement: string;
	path: string | null;
	reasons: DriftHit["reasons"];
}

interface DriftPacket {
	rev: string;
	files: string[];
	truncated: boolean;
	commits: { sha: string; subject: string }[];
	ideas: DriftIdea[];
	excluded: string[];
	instruction: string;
}

type Outcome = { skipped: string; tier?: number } | { packet: DriftPacket };

function packetFrom(io: Io, root: string, rev: string): Outcome {
	const paths = rootsPaths(root);
	const config = loadConfig(paths);
	if (config.tier < DRIFT_TIER) return { skipped: "tier", tier: config.tier };
	const g = gatherDrift(root, io.env, rev);
	if (!g.ok) return { skipped: `git: ${g.reason}` };
	const graph = readGraph(paths);
	const dirs = scanNodeDirs(paths);
	const match = matchDrift({
		graph,
		config,
		ideas: driftIdeas(paths, graph, dirs),
		files: g.files,
		commits: g.commits,
		issues: readSeedsIssues(root),
	});
	const ideas = match.touched.map(({ node, reasons }) => ({
		id: node.id,
		slug: node.slug,
		status: node.status,
		statement: readClaim(paths, graph, node, dirs).statement,
		path: ideaFile(paths, node, dirs),
		reasons,
	}));
	return {
		packet: {
			rev,
			files: g.files,
			truncated: g.truncated,
			commits: g.commits.map(({ sha, subject }: DriftCommit) => ({ sha, subject })),
			ideas,
			excluded: match.excluded,
			instruction: DRIFT_INSTRUCTION,
		},
	};
}

function computeDrift(io: Io, rev: string): Outcome {
	const root = findProjectRoot(io.cwd);
	if (root === null) return { skipped: "not a roots project" };
	try {
		return packetFrom(io, root, rev);
	} catch (err) {
		// Hook-safe: a broken config or unreadable file must not fail the session.
		return { skipped: `error: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function ideaSection(i: DriftIdea): string[] {
	const lines = ["", `## ${i.id} ${i.slug} (${i.status})`, "", `> ${i.statement || "(empty)"}`, ""];
	if (i.path) lines.push(`- file: ${i.path} (human-owned: never edit it)`);
	for (const r of i.reasons) lines.push(`- ${r.kind}: ${r.detail}`);
	return lines;
}

export function renderDriftMarkdown(p: DriftPacket): string {
	const n = p.ideas.length;
	const shown = p.files.slice(0, SHOWN_FILES);
	const more = p.files.length - shown.length + (p.truncated ? 1 : 0);
	const lines = [
		`# luuna-roots drift: ${n} idea${n === 1 ? "" : "s"} touched by changes since ${p.rev}`,
		"",
		p.instruction,
		"",
		`Changed files (${p.files.length}${p.truncated ? "+" : ""}): ${shown.join(", ")}${more > 0 ? ", …" : ""}`,
	];
	if (p.commits.length > 0) {
		lines.push(`Commits: ${p.commits.map((c) => `${c.sha} ${c.subject}`).join("; ")}`);
	}
	lines.push(...p.ideas.flatMap(ideaSection));
	return `${lines.join("\n")}\n`;
}

async function report(io: Io, out: Output, outcome: Outcome): Promise<void> {
	if ("skipped" in outcome) {
		await out.result({ ...outcome, ideas: [] });
		return;
	}
	const p = outcome.packet;
	await out.result({ skipped: null, ...p });
	if (!out.json && p.ideas.length > 0) await io.stdout(renderDriftMarkdown(p));
}

export const driftCommand: CommandDef = {
	name: "drift",
	group: "agent",
	summary: "Ideas a repo change touches (tier 3; the Stop hook)",
	usage: "drift [--diff <rev>]",
	description:
		"Read-only. Lists live ideas touched by changes since <rev> (default HEAD: uncommitted\n" +
		"and untracked files): slug words in a changed path, idea/notes or a linked seeds issue\n" +
		"naming a changed file, or a commit in <rev>..HEAD citing the r- id; plus the ideas they\n" +
		"serve. The agent may then `luuna-roots ask <id>` whether the idea still holds.\n" +
		"Hook-safe: never exits non-zero for git/tier/project reasons; below project tier 3\n" +
		"(or with nothing touched) it prints nothing. --json always explains (`skipped`).",
	flags: {
		diff: {
			type: "string",
			placeholder: "<rev>",
			description: "Compare the working tree against <rev> (default HEAD)",
		},
	},
	maxArgs: 0,
	async run({ io, out, flags }) {
		const rev = flagString(flags, "diff") ?? "HEAD";
		await report(io, out, computeDrift(io, rev));
	},
};
