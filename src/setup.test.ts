import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DRIFT_HOOK,
	desiredHooks,
	GUARD_HOOK,
	PRIME_HOOK,
	syncRootsHooks,
} from "./claude-settings.ts";
import { initProject, patchConfig, run, runJson, spawnCli, tempDir } from "./test-helpers.ts";

const USER_HOOK = {
	matcher: "Bash",
	hooks: [{ type: "command", command: "ml prime" }],
};

function settingsOf(root: string) {
	return JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
}

describe("claude-settings", () => {
	test("drift hook only at tier 3 and only once `drift` exists", () => {
		const none = () => false;
		const all = () => true;
		expect(desiredHooks({ tier: 3, hasCommand: none })).toEqual([PRIME_HOOK, GUARD_HOOK]);
		expect(desiredHooks({ tier: 2, hasCommand: all })).toEqual([PRIME_HOOK, GUARD_HOOK]);
		expect(desiredHooks({ tier: 3, hasCommand: all })).toEqual([
			PRIME_HOOK,
			GUARD_HOOK,
			DRIFT_HOOK,
		]);
		expect(desiredHooks({ tier: null, hasCommand: all })).toEqual([PRIME_HOOK, GUARD_HOOK]);
	});

	test("install is idempotent, keeps other hooks, replaces stale roots entries", () => {
		const before = {
			model: "opus",
			hooks: {
				PreToolUse: [
					USER_HOOK,
					{ matcher: "Write", hooks: [{ type: "command", command: "luuna-roots guard --old" }] },
				],
			},
		};
		const want = [PRIME_HOOK, GUARD_HOOK];
		const once = syncRootsHooks(before, want);
		expect(once.changed).toBe(true);
		expect(before.hooks.PreToolUse).toHaveLength(2); // input not mutated
		const s = once.settings as { model: string; hooks: Record<string, unknown[]> };
		expect(s.model).toBe("opus");
		expect(s.hooks.PreToolUse).toEqual([
			USER_HOOK,
			{ matcher: GUARD_HOOK.matcher, hooks: [{ type: "command", command: "luuna-roots guard" }] },
		]);
		expect(s.hooks.SessionStart).toEqual([
			{ hooks: [{ type: "command", command: "luuna-roots prime --hook" }] },
		]);
		const twice = syncRootsHooks(once.settings, want);
		expect(twice.changed).toBe(false);
		expect(twice.settings).toBe(once.settings);
	});

	test("a roots handler sharing a group with a user handler is split out", () => {
		const before = {
			hooks: {
				SessionStart: [
					{
						hooks: [
							{ type: "command", command: "ml prime" },
							{ type: "command", command: "luuna-roots prime" },
						],
					},
				],
			},
		};
		const r = syncRootsHooks(before, [PRIME_HOOK]);
		expect((r.settings as { hooks: { SessionStart: unknown } }).hooks.SessionStart).toEqual([
			{ hooks: [{ type: "command", command: "ml prime" }] },
			{ hooks: [{ type: "command", command: "luuna-roots prime --hook" }] },
		]);
	});

	test("remove strips only roots handlers and empty containers", () => {
		const installed = syncRootsHooks({ hooks: { PreToolUse: [USER_HOOK] } }, [
			PRIME_HOOK,
			GUARD_HOOK,
			DRIFT_HOOK,
		]).settings;
		const removed = syncRootsHooks(installed, []);
		expect(removed.settings).toEqual({ hooks: { PreToolUse: [USER_HOOK] } });
		expect(syncRootsHooks({ theme: "dark" }, []).changed).toBe(false);
		const onlyRoots = syncRootsHooks({}, [PRIME_HOOK]).settings;
		expect(syncRootsHooks(onlyRoots, []).settings).toEqual({});
	});
});

describe("luuna-roots setup claude", () => {
	test("project scope: writes .claude/settings.json at the project root, idempotent", async () => {
		const root = await initProject();
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, ".claude"));
		writeFileSync(
			join(root, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [USER_HOOK] } }),
		);
		const r = await runJson<{ changed: boolean; hooks: unknown[]; path: string }>(
			["setup", "claude"],
			join(root, "src"),
		);
		expect(r.exitCode).toBe(0);
		expect(r.body.changed).toBe(true);
		expect(r.body.path).toBe(join(root, ".claude", "settings.json"));
		const s = settingsOf(root);
		expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
		expect(s.hooks.PreToolUse[0]).toEqual(USER_HOOK);
		expect(s.hooks.SessionStart[0].hooks[0].command).toBe("luuna-roots prime --hook");
		expect(s.hooks.Stop).toBeUndefined();
		const text = readFileSync(join(root, ".claude", "settings.json"), "utf8");
		const again = await runJson<{ changed: boolean }>(["setup", "claude"], root);
		expect(again.body.changed).toBe(false);
		expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toBe(text);
	});

	test("tier 3 installs the Stop drift hook; dropping the tier removes it on re-run", async () => {
		const root = await initProject();
		await patchConfig(root, { tier: 3 });
		const up = await runJson<{ changed: boolean }>(["setup", "claude"], root);
		expect(up.body.changed).toBe(true);
		expect(settingsOf(root).hooks.Stop).toEqual([
			{ hooks: [{ type: "command", command: "luuna-roots drift --diff HEAD" }] },
		]);
		const again = await runJson<{ changed: boolean }>(["setup", "claude"], root);
		expect(again.body.changed).toBe(false);
		await patchConfig(root, { tier: 2 });
		const down = await runJson<{ changed: boolean }>(["setup", "claude"], root);
		expect(down.body.changed).toBe(true);
		const s = settingsOf(root);
		expect(s.hooks.Stop).toBeUndefined();
		expect(s.hooks.SessionStart[0].hooks[0].command).toBe("luuna-roots prime --hook");
		await patchConfig(root, { tier: 3 });
		await run(["setup", "claude"], root);
		await run(["setup", "claude", "--remove"], root);
		expect(settingsOf(root)).toEqual({});
	});

	test("--dry-run writes nothing; --user uses $HOME", async () => {
		const root = await initProject();
		const dry = await run(["setup", "claude", "--dry-run"], root);
		expect(dry.stdout).toContain('"luuna-roots guard"');
		expect(existsSync(join(root, ".claude"))).toBe(false);
		const home = tempDir();
		const u = await runJson<{ scope: string }>(["setup", "claude", "--user"], root, {
			env: { HOME: home },
		});
		expect(u.body.scope).toBe("user");
		expect(settingsOf(home).hooks.PreToolUse[0].hooks[0].command).toBe("luuna-roots guard");
		expect(existsSync(join(root, ".claude"))).toBe(false);
	});

	test("--remove; refused inside an agent session", async () => {
		const root = await initProject();
		await run(["setup", "claude"], root);
		for (const env of [{ ROOTS_AGENT: "agent:x" }, { CLAUDECODE: "1" }]) {
			const r = await runJson(["setup", "claude", "--remove"], root, { env });
			expect(r.exitCode).toBe(4);
		}
		const r = await runJson<{ changed: boolean }>(["setup", "claude", "--remove"], root);
		expect(r.body.changed).toBe(true);
		expect(settingsOf(root)).toEqual({});
	});

	test("errors: unknown target, both scopes, malformed settings (left untouched)", async () => {
		const root = await initProject();
		expect((await runJson(["setup", "cursor"], root)).exitCode).toBe(2);
		expect((await runJson(["setup", "claude", "--user", "--project"], root)).exitCode).toBe(2);
		mkdirSync(join(root, ".claude"));
		writeFileSync(join(root, ".claude", "settings.json"), "{ nope");
		const bad = await runJson<{ error: string }>(["setup", "claude"], root);
		expect(bad.exitCode).toBe(6);
		expect(bad.body.error).toContain("nothing was written");
		expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toBe("{ nope");
		writeFileSync(join(root, ".claude", "settings.json"), '{"hooks": []}');
		expect((await runJson(["setup", "claude"], root)).exitCode).toBe(6);
	});

	test("smoke: the real binary", async () => {
		const root = await initProject();
		const r = await spawnCli(["setup", "claude"], root);
		expect(r.exitCode).toBe(0);
		expect(settingsOf(root).hooks.SessionStart).toHaveLength(1);
	});
});

describe("luuna-roots prime --hook", () => {
	test("silent outside a roots project; normal inside", async () => {
		const outside = await run(["prime", "--hook"], tempDir());
		expect([outside.exitCode, outside.stdout, outside.stderr]).toEqual([0, "", ""]);
		const plain = await run(["prime"], tempDir());
		expect(plain.exitCode).toBe(3);
		const root = await initProject();
		const inside = await run(["prime", "--hook"], root);
		expect(inside.stdout).toContain("# Roots: project intent");
	});
});
