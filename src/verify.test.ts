import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CommitInfo, isAgentCommit } from "./git-trust.ts";
import { updateGraph } from "./graph.ts";
import { rootsPaths } from "./paths.ts";
import { BASE_ENV, initProject, plant, run, runJson, spawnCli, tempDir } from "./test-helpers.ts";
import { lastTrustedHash } from "./verify-boundary.ts";

interface Issue {
	code: string;
	severity: string;
	file?: string;
	line?: number;
	node?: string;
}

async function verify(root: string) {
	const r = await runJson<{ success: boolean; issues: Issue[] }>(["verify"], root);
	return { exitCode: r.exitCode, issues: r.body.issues ?? [], body: r.body };
}

function codes(issues: Issue[]): string[] {
	return issues.map((i) => i.code).sort();
}

function ideaMd(root: string, id: string): string {
	const dir = join(root, ".luuna/roots", "human");
	const name = readdirSync(dir).find((n) => n.startsWith(`${id.slice(2)}-`)) ?? "";
	return join(dir, name, "idea.md");
}

function git(root: string, ...args: string[]) {
	const r = spawnSync("git", ["-c", "user.name=Test Human", "-c", "user.email=t@h.io", ...args], {
		cwd: root,
		env: BASE_ENV as NodeJS.ProcessEnv,
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function gitProject() {
	const root = await initProject();
	git(root, "init", "-q");
	const id = await plant(root, "Sync works offline");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	return { root, id };
}

describe("isAgentCommit", () => {
	const base: CommitInfo = {
		sha: "abc",
		authorName: "Jaymin West",
		authorEmail: "j@x.io",
		committerName: "Jaymin West",
		committerEmail: "j@x.io",
		message: "fix things\n",
	};
	test("human", () => expect(isAgentCommit(base)).toBeNull());
	test("Co-Authored-By Claude trailer", () =>
		expect(
			isAgentCommit({
				...base,
				message: "x\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>\n",
			}),
		).toContain("co-authored"));
	test("bot author / agent names / anthropic email", () => {
		expect(isAgentCommit({ ...base, authorName: "dependabot[bot]" })).not.toBeNull();
		expect(isAgentCommit({ ...base, authorName: "Claude" })).not.toBeNull();
		expect(isAgentCommit({ ...base, committerEmail: "noreply@anthropic.com" })).not.toBeNull();
		expect(isAgentCommit({ ...base, authorName: "Claude Dupont" })).toBeNull();
	});
});

describe("luuna-roots verify", () => {
	test("a fresh project passes", async () => {
		const root = await initProject();
		await plant(root, "Sync works offline");
		const r = await verify(root);
		expect(r.exitCode).toBe(0);
		expect(r.body.success).toBe(true);
		expect(r.issues).toEqual([]);
		const text = await run(["verify"], root);
		expect(text.stdout).toContain("no problems found");
	});

	test("tampered idea.md without git: warning only", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		appendFileSync(ideaMd(root, id), "\nan agent was here\n");
		const r = await verify(root);
		expect(r.exitCode).toBe(0);
		expect(r.issues).toEqual([
			expect.objectContaining({ code: "ledger.unverifiable", severity: "warning", node: id }),
		]);
	});

	test("hash ledger with git: dirty edit fails; human commit passes; agent commit fails", async () => {
		const { root, id } = await gitProject();
		expect((await verify(root)).exitCode).toBe(0);
		const file = ideaMd(root, id);
		appendFileSync(file, "\nedited outside a session\n");
		const dirty = await verify(root);
		expect(dirty.exitCode).toBe(6);
		expect(codes(dirty.issues)).toEqual(["ledger.untrusted-edit"]);
		git(root, "commit", "-qam", "human edit");
		expect((await verify(root)).exitCode).toBe(0);
		appendFileSync(file, "\nagent edit\n");
		git(root, "commit", "-qam", "tweak\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
		const agent = await verify(root);
		expect(agent.exitCode).toBe(6);
		expect(codes(agent.issues)).toEqual(["ledger.agent-commit"]);
		// A scan must not launder the edit.
		await run(["scan"], root);
		expect(codes((await verify(root)).issues)).toEqual(["ledger.agent-commit"]);
	});

	test("lastTrustedHash ignores scan and non-human events", () => {
		const events = [
			{ type: "plant" as const, by: "human:a", at: "", node: "r-1", hash: "h1" },
			{ type: "scan" as const, by: "human:a", at: "", node: "r-1", scannedHash: "h2" },
			{ type: "session.end" as const, by: "agent:x", at: "", node: "r-1", hash: "h3" },
		];
		expect(lastTrustedHash(events, "r-1")).toBe("h1");
	});

	test("boundary: stray files, symlinks out of human/, dotfiles", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const dir = join(ideaMd(root, id), "..");
		const human = join(root, ".luuna/roots", "human");
		writeFileSync(join(human, "stray.md"), "x");
		mkdirSync(join(human, "ffff-unknown"));
		writeFileSync(join(dir, "notes.md"), "x");
		mkdirSync(join(dir, "assets"));
		writeFileSync(join(dir, "assets", "sketch.png"), "x");
		symlinkSync("/etc/hosts", join(dir, "assets", "leak"));
		symlinkSync(join(dir, "idea.md"), join(dir, "assets", "self-link"));
		writeFileSync(join(dir, ".idea.md.swp"), "x");
		const r = await verify(root);
		expect(r.exitCode).toBe(6);
		expect(codes(r.issues)).toEqual([
			"boundary.hidden",
			"boundary.stray",
			"boundary.stray",
			"boundary.stray",
			"boundary.symlink",
		]);
		expect(r.issues.find((i) => i.code === "boundary.symlink")?.file).toContain("assets/leak");
	});

	test("records: JSONL parse errors with line numbers, authors, dangling refs, no-by", async () => {
		const root = await initProject();
		const id = await plant(root, "Sync works offline");
		const paths = rootsPaths(root);
		await updateGraph(paths, (g) => {
			const n = g.nodes[0];
			if (n) n.author = "agent:sneaky";
			g.edges.push({
				type: "edge",
				id: "e-0001",
				from: id,
				to: "r-dead",
				rel: "serves",
				by: "agent:x",
				createdAt: "2026-01-01T00:00:00Z",
			});
			return { write: true, result: null };
		});
		appendFileSync(paths.graph, "<<<<<<< HEAD\n");
		appendFileSync(paths.graph, `${JSON.stringify({ type: "node", id: "r-bad" })}\n`);
		appendFileSync(
			paths.questions,
			`${JSON.stringify({ id: "q-1", node: "r-gone", text: "?", by: "roots:x", status: "open", createdAt: "" })}\n`,
		);
		appendFileSync(paths.events, `${JSON.stringify({ type: "plant", at: "", node: id })}\n`);
		const r = await verify(root);
		expect(r.exitCode).toBe(6);
		expect(codes(r.issues)).toEqual([
			"author.edge",
			"author.idea",
			"event.no-by",
			"jsonl.parse",
			"record.invalid",
			"ref.dangling",
			"ref.dangling",
		]);
		const parse = r.issues.find((i) => i.code === "jsonl.parse");
		expect(parse).toMatchObject({ file: ".luuna/roots/graph.jsonl", line: 3 });
		expect(r.issues.find((i) => i.code === "record.invalid")?.line).toBe(4);
		const text = await run(["verify"], root);
		expect(text.stdout).toContain(".luuna/roots/graph.jsonl:3");
		expect(text.stderr).toContain("7 errors");
	});

	test("graph invariants and node directories", async () => {
		const root = await initProject();
		const a = await plant(root, "Idea A");
		const b = await plant(root, "Idea B");
		await updateGraph(rootsPaths(root), (g) => {
			for (const [id, from, to] of [
				["e-0001", a, b],
				["e-0002", b, a],
			] as const) {
				g.edges.push({ type: "edge", id, from, to, rel: "serves", by: "human:t", createdAt: "" });
			}
			return { write: true, result: null };
		});
		rmSync(ideaMd(root, b));
		mkdirSync(join(root, ".luuna/roots", "agent", "sprouts", "abcd-ghost"), { recursive: true });
		const r = await verify(root);
		expect(codes(r.issues)).toEqual([
			"dir.missing",
			"dir.orphan",
			"graph.invariant",
			"graph.invariant",
		]);
		expect(readFileSync(rootsPaths(root).graph, "utf8")).toContain("e-0002");
	});

	test("smoke: the real binary exits 6 on errors", async () => {
		const root = await initProject();
		writeFileSync(join(root, ".luuna/roots", "human", "stray.txt"), "x");
		const r = await spawnCli(["verify"], root);
		expect(r.exitCode).toBe(6);
		expect(r.stdout).toContain("boundary.stray");
		expect((await spawnCli(["verify"], tempDir())).exitCode).toBe(3);
	});
});
