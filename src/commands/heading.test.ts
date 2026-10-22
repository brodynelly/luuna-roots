import { describe, expect, test } from "bun:test";
import { EXIT } from "../errors.ts";
import { appendEvent, makeEvent, readEvents } from "../events.ts";
import {
	activeHeading,
	dismissedHeadings,
	dismissHeading,
	readHeadings,
	sentenceCount,
} from "../headings.ts";
import { rootsPaths } from "../paths.ts";
import { initProject, patchConfig, plant, runJson } from "../test-helpers.ts";

const AGENT = ["--as", "agent:opus"];

type Filed = { id?: string; error?: string; heading?: { next?: string; cites: unknown[] } };

async function setup() {
	const root = await initProject();
	const a = await plant(root, "Every action has a named principal");
	const b = await plant(root, "No long-lived secret enters a sandbox");
	const paths = rootsPaths(root);
	await appendEvent(paths, makeEvent("flow.start", "human:test-human", { flow: "fl-0001" }));
	return { root, a, b, paths };
}

function heading(root: string, text: string, extra: string[] = []) {
	return runJson<Filed>(["heading", text, "--flow", "fl-0001", ...extra, ...AGENT], root);
}

describe("luuna-roots heading", () => {
	test("files a cited heading; the newest active one is shown; event logged", async () => {
		const { root, a, b, paths } = await setup();
		const r = await heading(root, `Converging on ${a}.`, [
			"--cite",
			`${a}:named principal`,
			"--next",
			b,
		]);
		expect(r.exitCode).toBe(0);
		expect(r.body.heading?.next).toBe(b);
		const r2 = await heading(root, "Principals first.", ["--cite", `${a}:Every action`]);
		expect(r2.exitCode).toBe(0);
		expect(activeHeading(readHeadings(paths), "fl-0001")?.id).toBe(r2.body.id);
		const ev = readEvents(paths).filter((e) => e.type === "heading");
		expect(ev.map((e) => e.by)).toEqual(["agent:opus", "agent:opus"]);
		expect(ev[0]?.refs).toEqual([a, b]);
	});

	test("refuses: no flow, ended flow, no cite, bad quote, uncited id, long, 3 sentences", async () => {
		const { root, a, b, paths } = await setup();
		const cite = ["--cite", `${a}:named principal`];
		const noFlow = await runJson<Filed>(["heading", "x.", ...cite, ...AGENT], root);
		expect(noFlow.body.error).toContain("no flow session");
		expect((await heading(root, "Going somewhere.")).body.error).toContain("cite at least one");
		expect((await heading(root, "x.", ["--cite", `${a}:nope`])).body.error).toContain("not found");
		expect((await heading(root, `About ${b}.`, cite)).body.error).toContain(`names ${b}`);
		expect((await heading(root, "x".repeat(300), cite)).body.error).toContain("300 characters");
		expect((await heading(root, "One. Two. Three.", cite)).body.error).toContain(
			"at most 2 sentences",
		);
		expect((await heading(root, "See q-dead.", cite)).body.error).toContain("no such question");
		await appendEvent(paths, makeEvent("flow.end", "human:test-human", { flow: "fl-0001" }));
		expect((await heading(root, "Late.", cite)).exitCode).toBe(EXIT.guard);
	});

	test("tier 0 refuses; a dismissed text is never filed again", async () => {
		const { root, a, paths } = await setup();
		const cite = ["--cite", `${a}:named principal`];
		const r = await heading(root, "Principals.", cite);
		await dismissHeading(paths, r.body.id ?? "", "human:test-human");
		expect(activeHeading(readHeadings(paths), "fl-0001")).toBeNull();
		expect(dismissedHeadings(readHeadings(paths))).toEqual(["Principals."]);
		expect((await heading(root, "Principals.", cite)).body.error).toContain("dismissed");
		expect(readEvents(paths).some((e) => e.type === "heading.dismiss")).toBe(true);
		await patchConfig(root, { tier: 0 });
		expect((await heading(root, "Other.", cite)).exitCode).toBe(EXIT.guard);
	});
});

test("sentenceCount", () => {
	expect(sentenceCount("One. Two?")).toBe(2);
	expect(sentenceCount("No end")).toBe(1);
	expect(sentenceCount("v1.2 works. Done!")).toBe(2);
});
