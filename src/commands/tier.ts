// luuna-roots tier <id> [<0-3>|default] (human, no TTY): per-idea agent tier
// override. With no tier, prints the effective tier. The override is the node
// field `tier` in graph.jsonl; `default` removes it. One `tier` event per change.

import { resolveHumanActor } from "../actor.ts";
import type { Tier } from "../config.ts";
import { loadConfig } from "../config.ts";
import { NotFoundError } from "../errors.ts";
import { appendEvent, makeEvent } from "../events.ts";
import { findNode, updateGraph } from "../graph.ts";
import { refuseAgentSession } from "../guard.ts";
import type { RootsPaths } from "../paths.ts";
import type { CommandDef } from "../registry.ts";
import { resolveNode } from "../resolve.ts";
import { effectiveTier, isTier, parseTier } from "../tier.ts";
import { isoNow } from "../time.ts";
import { openWorkspace } from "../workspace.ts";

export interface TierChange {
	from: Tier | null;
	to: Tier | null;
}

/** Set (or with `null` clear) a node's tier override. Returns null when nothing changed. */
export async function setTierOverride(
	paths: RootsPaths,
	id: string,
	tier: Tier | null,
): Promise<TierChange | null> {
	return updateGraph(paths, (graph) => {
		const node = findNode(graph, id);
		if (!node) throw new NotFoundError(`node ${id} disappeared`);
		const from = isTier(node.tier) ? node.tier : null;
		if (from === tier) return { write: false, result: null };
		if (tier === null) delete node.tier;
		else node.tier = tier;
		node.updatedAt = isoNow();
		return { write: true, result: { from, to: tier } };
	});
}

export const tierCommand: CommandDef = {
	name: "tier",
	group: "structure",
	summary: "Per-idea agent tier override",
	usage: "tier <id> [<0-3>|default]",
	description:
		"Tiers: 0 off, 1 ask, 2 propose, 3 observe. `luuna-roots tier <id> 0` keeps agents out of an\n" +
		"idea you want to think about alone; `default` removes the override so the idea\n" +
		"follows `tier:` in .luuna/roots/config.yaml. With no tier, prints the effective tier.",
	minArgs: 1,
	maxArgs: 2,
	async run({ io, out, args }) {
		const [query = "", raw] = args;
		const ws = await openWorkspace(io.cwd);
		const node = resolveNode(ws.graph.nodes, query, { kind: "idea" });
		const config = loadConfig(ws.paths);
		if (raw === undefined) {
			const eff = effectiveTier(config, node);
			await out.result({ id: node.id, ...eff, config: config.tier });
			const via = eff.source === "idea" ? "per-idea override" : "from config.yaml";
			await out.line(`${out.c.id(node.id)} ${node.slug}  tier ${eff.tier} (${eff.name}, ${via})`);
			return;
		}
		refuseAgentSession(io, "tier");
		const by = resolveHumanActor(io);
		const tier = raw.trim().toLowerCase() === "default" ? null : parseTier(raw);
		const change = await setTierOverride(ws.paths, node.id, tier);
		if (change) {
			await appendEvent(ws.paths, makeEvent("tier", by, { node: node.id, ...change }));
		}
		const eff = effectiveTier(config, tier === null ? {} : { tier });
		await out.result({ id: node.id, changed: change !== null, override: tier, ...eff });
		const label = `tier ${eff.tier} (${eff.name}${tier === null ? ", from config.yaml" : ""})`;
		if (!change) await out.info(`${out.c.id(node.id)} ${node.slug} is already at ${label}`);
		else await out.success(`${out.c.id(node.id)} ${node.slug} → ${label}`);
	},
};
