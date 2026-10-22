import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../errors.ts";
import { readEvents } from "../events.ts";
import { NOTE_MAX_BYTES, noteFileName } from "../notes.ts";
import { rootsPaths } from "../paths.ts";
import { addQuestions, delegateQuestion, readQuestions } from "../questions.ts";
import { initProject, plant, run, runJson } from "../test-helpers.ts";

const AGENT = ["--as", "agent:opus"];
const today = () => new Date().toISOString().slice(0, 10);

type Noted = { id: string; note: { name: string; path: string; bytes: number }; error?: string };

async function setup() {
	const root = await initProject();
	const a = await plant(root, "Sync works offline");
	writeFileSync(join(root, "Prior Art.md"), "# prior art\n");
	return { root, a, hex: a.slice(2), paths: rootsPaths(root) };
}

describe("luuna-roots note", () => {
	test("copies into agent/notes/<hex>/YYYY-MM-DD-<slug>.<ext>; collisions get a suffix", async () => {
		const { root, a, hex, paths } = await setup();
		const first = await runJson<Noted>(["note", a, "--file", "Prior Art.md", ...AGENT], root, {
			tty: false,
		});
		expect(first.exitCode).toBe(0);
		expect(first.body.note.path).toBe(`.luuna/roots/agent/notes/${hex}/${today()}-prior-art.md`);
		expect(readFileSync(join(root, first.body.note.path), "utf8")).toBe("# prior art\n");
		const second = await runJson<Noted>(["note", a, "--file", "Prior Art.md", ...AGENT], root);
		expect(second.body.note.name).toBe(`${today()}-prior-art-2.md`);
		const named = await runJson<Noted>(
			["note", a, "--file", "Prior Art.md", "--name", "../../human/Diagram.SVG", ...AGENT],
			root,
		);
		expect(named.body.note.path).toBe(`.luuna/roots/agent/notes/${hex}/${today()}-human-diagram.svg`);
		expect(readEvents(paths).filter((e) => e.type === "note")).toHaveLength(3);
		const show = await runJson<{ notes: { name: string }[] }>(["show", a], root);
		expect(show.body.notes).toHaveLength(3);
		const ctx = await runJson<{ notes: { path: string }[] }>(["context", a, "--no-repo"], root);
		expect(ctx.body.notes.map((n) => n.path)).toContain(first.body.note.path);
		expect((await run(["show", a], root)).stdout).toContain("Agent notes (3)");
	});

	test("size cap, missing file, directories and .luuna/roots/ sources are refused", async () => {
		const { root, a, paths } = await setup();
		writeFileSync(join(root, "big.bin"), Buffer.alloc(NOTE_MAX_BYTES + 1));
		const big = await runJson<Noted>(["note", a, "--file", "big.bin", ...AGENT], root);
		expect(big.exitCode).toBe(EXIT.validation);
		expect((await runJson(["note", a, "--file", "nope", ...AGENT], root)).exitCode).toBe(
			EXIT.notFound,
		);
		expect((await runJson(["note", a, "--file", ".", ...AGENT], root)).exitCode).toBe(EXIT.usage);
		const inner = await runJson(["note", a, "--file", ".luuna/roots/graph.jsonl", ...AGENT], root);
		expect(inner.exitCode).toBe(EXIT.usage);
		expect((await runJson(["note", a, ...AGENT], root)).exitCode).toBe(EXIT.usage);
		expect(existsSync(paths.notes) ? readdirSync(paths.notes) : []).toEqual([]);
	});

	test("tier ≥ 1 for the idea (per-idea override wins); agents only; ideas only", async () => {
		const { root, a } = await setup();
		await run(["tier", a, "0"], root);
		const off = await runJson<Noted>(["note", a, "--file", "Prior Art.md", ...AGENT], root);
		expect(off.exitCode).toBe(EXIT.guard);
		expect(off.body.error).toContain("tier 1");
		await run(["tier", a, "default"], root);
		const human = await runJson(["note", a, "--file", "Prior Art.md", "--as", "human:jay"], root);
		expect(human.exitCode).toBe(EXIT.guard);
		const s = await runJson<{ id: string }>(["sprout", "A sprout", ...AGENT], root);
		const onSprout = await runJson(["note", s.body.id, "--file", "Prior Art.md", ...AGENT], root);
		expect(onSprout.exitCode).toBe(EXIT.usage);
	});

	test("--question: delegated questions on this idea only, text files only", async () => {
		const { root, a, paths } = await setup();
		const b = await plant(root, "Conflicts are shown to the user");
		const [q, other] = await addQuestions(paths, [
			{ node: a, text: "Which services sync?", by: "roots:missing-done" },
			{ node: b, text: "Who resolves?", by: "roots:missing-done" },
		]);
		const qid = q?.id ?? "";
		const note = (file: string, id = qid, node = a) =>
			runJson<Noted & { question: string | null }>(
				["note", node, "--file", file, "--question", id, ...AGENT],
				root,
			);
		const notDelegated = await note("Prior Art.md");
		expect(notDelegated.exitCode).toBe(EXIT.validation);
		expect(notDelegated.body.error).toContain("is open; findings go only on questions");
		await delegateQuestion(paths, qid, { by: "human:jay", session: "ss-0001" });
		await delegateQuestion(paths, other?.id ?? "", { by: "human:jay", session: "ss-0001" });
		expect((await note("Prior Art.md", other?.id)).body.error).toContain(`not ${a}`);
		expect((await note("Prior Art.md", "q-dead")).exitCode).toBe(EXIT.notFound);
		writeFileSync(join(root, "chart.svg"), "<svg/>");
		expect((await note("chart.svg")).body.error).toContain("must be a text file");
		const ok = await note("Prior Art.md");
		expect(ok.exitCode).toBe(0);
		expect(ok.body.question).toBe(qid);
		const back = readQuestions(paths).find((x) => x.id === qid);
		expect(back).toMatchObject({ status: "open", findings: [{ note: ok.body.note.path }] });
		expect((await note("Prior Art.md")).body.error).toContain("is open");
	});

	test("noteFileName sanitizes every part", () => {
		const d = new Date("2026-09-28T10:00:00Z");
		expect(noteFileName("../../etc/passwd", d, new Set())).toBe("2026-09-28-etc-passwd");
		expect(noteFileName("x.tar.gz", d, new Set())).toBe("2026-09-28-x-tar.gz");
		expect(noteFileName("weird.ext!!", d, new Set(), "md")).toBe("2026-09-28-weird-ext.md");
		expect(noteFileName("", d, new Set(["2026-09-28-note"]))).toBe("2026-09-28-note-2");
	});
});
