import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "../events.ts";
import { rootsPaths } from "../paths.ts";
import { readProposals } from "../proposals.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";
import { lastRecordedHash } from "./scan.ts";

interface ScanBody {
	ideas: Array<{ node: string; changed: boolean; scanned: boolean; filed: Array<{ id: string }> }>;
}

async function setup() {
	const root = await initProject();
	const auth = await plant(root, "Login uses passkeys only");
	const sync = await plant(root, "Sync works offline");
	const file = join(root, ".luuna/roots/human", `${sync.slice(2)}-sync-works-offline`, "idea.md");
	return { root, auth, sync, file, paths: rootsPaths(root) };
}

describe("luuna-roots scan", () => {
	test("unchanged ideas are skipped; edits outside a session are scanned once", async () => {
		const { root, auth, sync, file, paths } = await setup();
		const none = await runJson<ScanBody>(["scan"], root);
		expect(none.body.ideas.every((i) => !i.scanned)).toBe(true);

		writeFileSync(file, "Sync works offline\n\nNeeds login-uses-passkeys to work offline too.\n");
		const r = await runJson<ScanBody>(["scan"], root);
		expect(r.exitCode).toBe(0);
		const entry = r.body.ideas.find((i) => i.node === sync);
		expect(entry).toMatchObject({ changed: true, scanned: true });
		expect(entry?.filed).toHaveLength(1);
		expect(readProposals(paths)).toMatchObject([
			{ from: sync, to: auth, rel: null, by: "roots:mention" },
		]);
		const scanEv = readEvents(paths).find((e) => e.type === "scan");
		expect(scanEv).toMatchObject({ node: sync, by: "human:test-human" });
		expect(scanEv && "hash" in scanEv).toBe(false); // never feeds verify's ledger

		const again = await runJson<ScanBody>(["scan", sync], root);
		expect(again.body.ideas).toMatchObject([{ node: sync, changed: false, scanned: false }]);
		const forced = await runJson<ScanBody>(["scan", "--all"], root);
		expect(forced.body.ideas.every((i) => i.scanned)).toBe(true);
		expect(readProposals(paths)).toHaveLength(1); // deduped
	});

	test("human output", async () => {
		const { root, file } = await setup();
		writeFileSync(file, "Sync works offline\nsee login uses passkeys\n");
		const r = await run(["scan"], root);
		expect(r.stdout).toContain("sync-works-offline ─?─");
		expect(r.stdout).toContain("1 proposal filed");
	});

	test("lastRecordedHash follows plant, session.end and scan", () => {
		const ev = (type: string, extra: Record<string, unknown>) =>
			({ type, by: "x", at: "", node: "r-1", ...extra }) as never;
		expect(
			lastRecordedHash(
				[
					ev("plant", { hash: "a" }),
					ev("session.end", { hash: "b" }),
					ev("scan", { scannedHash: "c" }),
				],
				"r-1",
			),
		).toBe("c");
		expect(lastRecordedHash([ev("plant", { hash: "a" })], "r-2")).toBeNull();
	});
});
