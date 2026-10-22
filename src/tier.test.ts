import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config.ts";
import { GuardError, UsageError } from "./errors.ts";
import { effectiveTier, parseTier, requireTier } from "./tier.ts";

const config = { ...defaultConfig("p"), tier: 1 as const };

describe("tiers", () => {
	test("override wins over config; invalid overrides are ignored", () => {
		expect(effectiveTier(config)).toEqual({ tier: 1, name: "ask", source: "config" });
		expect(effectiveTier(config, { tier: 0 })).toEqual({ tier: 0, name: "off", source: "idea" });
		expect(effectiveTier(config, { tier: 3 }).name).toBe("observe");
		expect(effectiveTier(config, { tier: 7 }).source).toBe("config");
		expect(effectiveTier(config, {}).source).toBe("config");
	});

	test("parseTier accepts digits and names", () => {
		expect(parseTier("2")).toBe(2);
		expect(parseTier("Ask")).toBe(1);
		expect(() => parseTier("4")).toThrow(UsageError);
		expect(() => parseTier("-1")).toThrow(UsageError);
		expect(() => parseTier("")).toThrow(UsageError);
	});

	test("requireTier names the tier needed and how to change it", () => {
		expect(requireTier(config, 1, "`luuna-roots ask`").tier).toBe(1);
		expect(() => requireTier(config, 2, "`luuna-roots propose`")).toThrow(GuardError);
		expect(() => requireTier(config, 2, "`luuna-roots propose`", { id: "r-a1b2" })).toThrow(
			/needs agent tier 2 \(propose\).*config.yaml.*luuna-roots tier r-a1b2 2/,
		);
		expect(() => requireTier(config, 1, "`luuna-roots ask`", { id: "r-a1b2", tier: 0 })).toThrow(
			/r-a1b2 is at tier 0 \(off\) by a per-idea override.*luuna-roots tier r-a1b2 1/,
		);
	});
});
