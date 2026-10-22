import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bashWritesHuman, decideHook, isProtectedPath } from "./hook-guard.ts";
import { initProject, run, spawnCli, tempDir } from "./test-helpers.ts";

function project() {
	const root = tempDir();
	const human = join(root, ".luuna/roots", "human", "a1b2-sync");
	mkdirSync(human, { recursive: true });
	writeFileSync(join(human, "idea.md"), "Sync\n");
	mkdirSync(join(root, "src"), { recursive: true });
	return { root, human };
}

describe("isProtectedPath", () => {
	test("absolute, relative, `..`, case", () => {
		const { root, human } = project();
		expect(isProtectedPath(join(human, "idea.md"), root)).toBe(true);
		expect(isProtectedPath(".luuna/roots/human/a1b2-sync/idea.md", root)).toBe(true);
		expect(isProtectedPath("../.luuna/roots/human/a1b2-sync/idea.md", join(root, "src"))).toBe(true);
		expect(isProtectedPath("src/../.luuna/roots/./human/new/idea.md", root)).toBe(true);
		expect(isProtectedPath(".Roots/Human/x.md", root)).toBe(true);
		expect(isProtectedPath(".luuna/roots/human", root)).toBe(true);
		expect(isProtectedPath(".luuna/roots/agent/notes/a1b2/x.md", root)).toBe(false);
		expect(isProtectedPath(".luuna/roots/humane/x.md", root)).toBe(false);
		expect(isProtectedPath("src/human/x.md", root)).toBe(false);
		expect(isProtectedPath(".luuna/roots/human/../agent/x.md", root)).toBe(false);
	});

	test("symlinks: link file, dangling link, linked directory", () => {
		const { root, human } = project();
		symlinkSync(join(human, "idea.md"), join(root, "src", "alias.md"));
		expect(isProtectedPath("src/alias.md", root)).toBe(true);
		symlinkSync(join(human, "not-yet.md"), join(root, "src", "dangling.md"));
		expect(isProtectedPath("src/dangling.md", root)).toBe(true);
		symlinkSync(human, join(root, "linkdir"));
		expect(isProtectedPath("linkdir/idea.md", root)).toBe(true);
		expect(isProtectedPath("linkdir/new/deep.md", root)).toBe(true);
		symlinkSync(join(root, "src"), join(root, "ok"));
		expect(isProtectedPath("ok/file.ts", root)).toBe(false);
	});
});

describe("bashWritesHuman (best effort)", () => {
	const cwd = "/tmp/x";
	const deny = [
		"echo hi > .luuna/roots/human/a/idea.md",
		"echo hi >>.luuna/roots/human/a/idea.md",
		'printf x > ".luuna/roots/human/a/idea.md"',
		"cat x | tee .luuna/roots/human/a/idea.md",
		"rm -rf .luuna/roots/human/a",
		"mv .luuna/roots/human/a .luuna/roots/agent/a",
		"cp /tmp/x.md .luuna/roots/human/a/idea.md",
		"sed -i '' 's/a/b/' .luuna/roots/human/a/idea.md",
		"perl -pi -e 's/a/b/' .luuna/roots/human/a/idea.md",
		"dd if=/dev/zero of=.luuna/roots/human/a/idea.md",
		"git checkout -- .luuna/roots/human/a/idea.md",
		"true && touch .luuna/roots/human/a/new.md",
		"FOO=1 sudo rm .luuna/roots/human/a/idea.md",
	];
	const allow = [
		"cat .luuna/roots/human/a/idea.md",
		"cat .luuna/roots/human/a/idea.md 2>/dev/null",
		"grep -r offline .luuna/roots/human",
		"cp .luuna/roots/human/a/idea.md /tmp/copy.md",
		"sed 's/a/b/' .luuna/roots/human/a/idea.md > /tmp/out.md",
		"ls .luuna/roots/human > /tmp/list.txt",
		"echo hi > notes.md",
		"git diff .luuna/roots/human",
	];
	for (const cmd of deny) test(`deny: ${cmd}`, () => expect(bashWritesHuman(cmd, cwd)).toBe(true));
	for (const cmd of allow)
		test(`allow: ${cmd}`, () => expect(bashWritesHuman(cmd, cwd)).toBe(false));
});

describe("decideHook", () => {
	test("tool matrix", () => {
		const { root } = project();
		const d = (tool_name: string, tool_input: unknown, cwd: string = root) =>
			decideHook({ tool_name, tool_input, cwd }, "/nowhere").decision;
		const file = ".luuna/roots/human/a1b2-sync/idea.md";
		for (const t of ["Write", "Edit", "MultiEdit"]) {
			expect(d(t, { file_path: file })).toBe("deny");
			expect(d(t, { file_path: "src/app.ts" })).toBe("allow");
		}
		expect(d("NotebookEdit", { notebook_path: ".luuna/roots/human/a1b2-sync/n.ipynb" })).toBe("deny");
		expect(d("Bash", { command: `echo x > ${file}` })).toBe("deny");
		expect(d("Bash", { command: `cat ${file}` })).toBe("allow");
		expect(d("Read", { file_path: file })).toBe("allow");
		expect(d("Write", {})).toBe("allow");
		// No cwd in the input: falls back to the process cwd.
		expect(decideHook({ tool_name: "Write", tool_input: { file_path: file } }, root).decision).toBe(
			"deny",
		);
	});
});

describe("luuna-roots guard", () => {
	test("deny prints Claude Code's PreToolUse JSON and exits 0", async () => {
		const { root } = project();
		const input = JSON.stringify({
			tool_name: "Edit",
			cwd: join(root, "src"),
			tool_input: { file_path: "../.luuna/roots/human/a1b2-sync/idea.md" },
		});
		const r = await run(["guard"], root, { stdin: input, tty: false });
		expect(r.exitCode).toBe(0);
		const body = JSON.parse(r.stdout);
		expect(body.hookSpecificOutput).toMatchObject({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
		});
		expect(body.hookSpecificOutput.permissionDecisionReason).toContain("luuna-roots ask");
	});

	test("allow is silent; malformed input fails open with a note", async () => {
		const { root } = project();
		const ok = JSON.stringify({ tool_name: "Write", cwd: root, tool_input: { file_path: "a.ts" } });
		const r = await run(["guard"], root, { stdin: ok, tty: false });
		expect([r.exitCode, r.stdout]).toEqual([0, ""]);
		const bad = await run(["guard"], root, { stdin: "{not json", tty: false });
		expect([bad.exitCode, bad.stdout]).toEqual([0, ""]);
		expect(bad.stderr).toContain("allowing");
		const json = await run(["guard", "--json"], root, {
			stdin: JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".luuna/roots/human/x" } }),
			tty: false,
		});
		expect(JSON.parse(json.stdout)).toMatchObject({ success: true, decision: "deny" });
	});

	test("smoke: the real binary reads stdin", async () => {
		const root = await initProject();
		const input = JSON.stringify({
			tool_name: "Write",
			cwd: root,
			tool_input: { file_path: ".luuna/roots/human/abcd-x/idea.md" },
		});
		const r = await spawnCli(["guard"], root, {}, input);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		const allow = await spawnCli(
			["guard"],
			root,
			{},
			JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
		);
		expect([allow.exitCode, allow.stdout]).toEqual([0, ""]);
	});
});
