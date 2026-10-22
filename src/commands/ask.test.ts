import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../errors.ts";
import { appendEvent, makeEvent, readEvents } from "../events.ts";
import { rootsPaths } from "../paths.ts";
import { readQuestions } from "../questions.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

const AS = ["--as", "agent:opus"];
const Q = "What happens to an offline edit on a deleted record?";

function snapshot(dir: string): string {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else out.push(`${p}:${readFileSync(p, "utf8")}`);
		}
	};
	walk(dir);
	return out.join("\n");
}

describe("luuna-roots ask", () => {
	test("records an open agent question with one ask event; never touches human/", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const paths = rootsPaths(root);
		const before = snapshot(paths.human);
		const r = await runJson<{ id: string; question: Record<string, unknown> }>(
			["ask", id, Q, ...AS],
			root,
			{ tty: false },
		);
		expect(r.exitCode).toBe(0);
		expect(r.body.question).toMatchObject({ node: id, text: Q, by: "agent:opus", status: "open" });
		expect(readEvents(paths).at(-1)).toMatchObject({ type: "ask", by: "agent:opus", node: id });
		expect(snapshot(paths.human)).toBe(before);
		// Unquoted words are joined; ROOTS_AGENT works as the identity.
		const words = await run(["ask", id, "Who", "decides", "conflicts?"], root, {
			env: { ROOTS_AGENT: "agent:opus" },
			tty: false,
		});
		expect(words.exitCode).toBe(0);
		expect(readQuestions(paths).at(-1)?.text).toBe("Who decides conflicts?");
	});

	test("refuses humans, missing identity, bad text", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const human = await runJson(["ask", id, Q, "--as", "human:jay"], root);
		expect(human.exitCode).toBe(EXIT.guard);
		expect((await runJson(["ask", id, Q], root)).exitCode).toBe(EXIT.guard);
		const noMark = await runJson<{ error: string }>(["ask", id, "Tell me more", ...AS], root);
		expect(noMark.exitCode).toBe(EXIT.validation);
		expect(noMark.body.error).toContain('end with "?"');
		const long = await runJson(["ask", id, `${"x".repeat(300)}?`, ...AS], root);
		expect(long.exitCode).toBe(EXIT.validation);
		expect((await runJson(["ask", id, "   ", ...AS], root)).exitCode).toBe(EXIT.usage);
		expect(readQuestions(rootsPaths(root))).toEqual([]);
	});

	test("duplicates of open or dismissed questions are refused (normalized)", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		await runJson(["ask", id, Q, ...AS], root);
		const dup = await runJson<{ error: string }>(
			["ask", id, "what happens to an OFFLINE edit on a deleted   record?", ...AS],
			root,
		);
		expect(dup.exitCode).toBe(EXIT.validation);
		expect(dup.body.error).toContain("duplicate of q-");
		// Dismissed questions are permanent memory.
		const paths = rootsPaths(root);
		const q = readQuestions(paths)[0];
		const { dismissQuestion } = await import("../questions.ts");
		await dismissQuestion(paths, q?.id ?? "", { by: "human:test-human", session: "ss-1" });
		const again = await runJson<{ error: string }>(["ask", id, Q, ...AS], root);
		expect(again.body.error).toContain("dismissed");
	});

	test("cap: open agent questions per idea ≤ questionsPerSession", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		for (const n of [1, 2, 3]) {
			expect((await runJson(["ask", id, `Question number ${n}?`, ...AS], root)).exitCode).toBe(0);
		}
		const over = await runJson<{ error: string; cap: number }>(
			["ask", id, "One more?", ...AS],
			root,
		);
		expect(over.exitCode).toBe(EXIT.validation);
		expect(over.body).toMatchObject({ cap: 3, open: 3 });
		expect(over.body.error).toContain("limits.questionsPerSession");
		// Another idea has its own cap.
		const other = await plant(root, "Auth is simple");
		expect((await runJson(["ask", other, "One more?", ...AS], root)).exitCode).toBe(0);
	});

	test("tier: project tier 0 and per-idea override 0 refuse, naming the fix", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		await run(["tier", id, "0"], root);
		const off = await runJson<{ error: string }>(["ask", id, Q, ...AS], root);
		expect(off.exitCode).toBe(EXIT.guard);
		expect(off.body.error).toContain(`luuna-roots tier ${id} 1`);
		await run(["tier", id, "default"], root);
		const cfg = join(root, ".luuna/roots", "config.yaml");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^tier: 2/m, "tier: 0"));
		const project = await runJson<{ error: string }>(["ask", id, Q, ...AS], root);
		expect(project.exitCode).toBe(EXIT.guard);
		expect(project.body.error).toContain("config.yaml");
		await run(["tier", id, "1"], root);
		expect((await runJson(["ask", id, Q, ...AS], root)).exitCode).toBe(0);
	});

	test("attaches to a live think session on the idea; ignores stale ones", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const paths = rootsPaths(root);
		await appendEvent(
			paths,
			makeEvent("session.start", "human:t", { node: id, session: "ss-abcd" }),
		);
		const live = await runJson<{ session: string | null }>(["ask", id, "First?", ...AS], root, {
			env: { ROOTS_SESSION: "ss-abcd" },
		});
		expect(live.body.session).toBe("ss-abcd");
		expect(readQuestions(paths)[0]?.session).toBe("ss-abcd");
		await appendEvent(paths, makeEvent("session.end", "human:t", { node: id, session: "ss-abcd" }));
		const stale = await runJson<{ session: string | null }>(
			["ask", id, "Second?", ...AS, "--session", "ss-abcd"],
			root,
		);
		expect(stale.exitCode).toBe(0);
		expect(stale.body.session).toBeNull();
	});
});
