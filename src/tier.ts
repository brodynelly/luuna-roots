// Agent tiers. Tiers only widen what an agent may
// suggest; no tier lets an agent write human content.
//
//   0 off      nothing (deterministic questions only)
//   1 ask      `luuna-roots ask`, `luuna-roots note`
//   2 propose  tier 1 + `luuna-roots propose`, `luuna-roots sprout`
//   3 observe  tier 2 + harness hooks on repo activity
//
// Effective tier for an idea = its per-idea override (node field `tier`, set
// by `luuna-roots tier <id> <0-3>`) else config.yaml `tier`. Agent commands call
// requireTier() before any write.

import type { RootsConfig, Tier } from "./config.ts";
import { GuardError, UsageError } from "./errors.ts";
import type { NodeRecord } from "./types.ts";

export const TIER_NAMES = ["off", "ask", "propose", "observe"] as const;

export type TierSource = "idea" | "config";

export interface EffectiveTier {
	tier: Tier;
	name: (typeof TIER_NAMES)[number];
	/** Where the tier came from: the idea's override or config.yaml. */
	source: TierSource;
}

export function isTier(n: unknown): n is Tier {
	return n === 0 || n === 1 || n === 2 || n === 3;
}

export function tierName(t: Tier): (typeof TIER_NAMES)[number] {
	return TIER_NAMES[t];
}

/** Parse a CLI tier argument ("0".."3" or a tier name). */
export function parseTier(raw: string): Tier {
	const s = raw.trim().toLowerCase();
	const byName = (TIER_NAMES as readonly string[]).indexOf(s);
	if (byName !== -1) return byName as Tier;
	const n = /^\d$/.test(s) ? Number(s) : Number.NaN;
	if (isTier(n)) return n;
	throw new UsageError(`tier must be 0-3 (${TIER_NAMES.join(", ")}), got "${raw}"`);
}

export function effectiveTier(
	config: Pick<RootsConfig, "tier">,
	node?: Pick<NodeRecord, "tier">,
): EffectiveTier {
	const override = node?.tier;
	if (isTier(override)) return { tier: override, name: tierName(override), source: "idea" };
	return { tier: config.tier, name: tierName(config.tier), source: "config" };
}

/**
 * Throw a GuardError unless the effective tier is at least `min`. The message
 * names the tier needed and how a human can change it.
 */
export function requireTier(
	config: Pick<RootsConfig, "tier">,
	min: Tier,
	action: string,
	node?: Pick<NodeRecord, "id" | "tier">,
): EffectiveTier {
	const eff = effectiveTier(config, node);
	if (eff.tier >= min) return eff;
	const need = `tier ${min} (${tierName(min)})`;
	const have = `tier ${eff.tier} (${eff.name})`;
	if (eff.source === "idea" && node) {
		throw new GuardError(
			`${action} needs agent ${need}; ${node.id} is at ${have} by a per-idea override. ` +
				`Only a human can raise it: \`luuna-roots tier ${node.id} ${min}\``,
		);
	}
	throw new GuardError(
		`${action} needs agent ${need}; this project is at ${have}. ` +
			`Only a human can raise it: set \`tier: ${min}\` in .luuna/roots/config.yaml` +
			(node ? ` or run \`luuna-roots tier ${node.id} ${min}\`` : ""),
	);
}
