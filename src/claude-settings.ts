// Claude Code hook wiring for `luuna-roots setup claude`. Pure: settings in,
// settings out.
//
// The real Claude Code schema nests handlers in
// matcher groups:
//   {"hooks": {"<Event>": [{"matcher": "...", "hooks": [{"type": "command",
//                                                         "command": "..."}]}]}}
// (matcher is omitted for SessionStart/Stop, where it would filter the
// session source, not a tool).
//
// Roots owns exactly the handlers whose command is `luuna-roots prime|guard|drift`
// (ROOTS_COMMAND_RE). Install strips those and appends one fresh group per
// wanted hook; everything else in settings.json is left as it was. When the
// wanted hooks are already present exactly (and no stray roots handlers), the
// event is left untouched, so re-running is a no-op. Remove strips roots
// handlers, then drops groups and events they leave empty.
//
// The Stop hook (`luuna-roots drift --diff HEAD`) is wanted only at tier 3 and only
// when a `drift` command exists (setup.ts passes hasCommand; imported directly,
// not via the command registry, to avoid a cli → register-all → setup cycle).

export type HookEvent = "SessionStart" | "PreToolUse" | "Stop";

export const MANAGED_EVENTS: readonly HookEvent[] = ["SessionStart", "PreToolUse", "Stop"];

export interface RootsHookSpec {
	event: HookEvent;
	matcher?: string;
	command: string;
}

export const PRIME_HOOK: RootsHookSpec = { event: "SessionStart", command: "luuna-roots prime --hook" };
export const GUARD_HOOK: RootsHookSpec = {
	event: "PreToolUse",
	matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
	command: "luuna-roots guard",
};
export const DRIFT_HOOK: RootsHookSpec = { event: "Stop", command: "luuna-roots drift --diff HEAD" };

export const ROOTS_COMMAND_RE = /^\s*(?:luuna-roots|roots)\s+(prime|guard|drift)(\s|$)/;

export interface HookContext {
	/** Project tier, or null when there is no project (e.g. --user outside one). */
	tier: number | null;
	/** Whether a roots subcommand exists (the drift hook needs `drift`). */
	hasCommand: (name: string) => boolean;
}

export function desiredHooks(ctx: HookContext): RootsHookSpec[] {
	const hooks = [PRIME_HOOK, GUARD_HOOK];
	if (ctx.tier === 3 && ctx.hasCommand("drift")) hooks.push(DRIFT_HOOK);
	return hooks;
}

type Json = Record<string, unknown>;

interface HookGroup extends Json {
	matcher?: string;
	hooks: Json[];
}

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isRootsHandler(h: unknown): boolean {
	return isObject(h) && typeof h.command === "string" && ROOTS_COMMAND_RE.test(h.command);
}

function groupHooks(g: unknown): unknown[] {
	return isObject(g) && Array.isArray(g.hooks) ? g.hooks : [];
}

function makeGroup(spec: RootsHookSpec): HookGroup {
	const hooks = [{ type: "command", command: spec.command }];
	return spec.matcher === undefined ? { hooks } : { matcher: spec.matcher, hooks };
}

/** The event already holds exactly these roots handlers, one per group as we write them. */
function alreadyInstalled(groups: readonly unknown[], specs: readonly RootsHookSpec[]): boolean {
	const roots = groups.flatMap((g) =>
		groupHooks(g)
			.filter(isRootsHandler)
			.map((h) => ({ g, h })),
	);
	if (roots.length !== specs.length) return false;
	return specs.every((spec) =>
		roots.some(
			({ g, h }) =>
				isObject(h) &&
				h.command === spec.command &&
				isObject(g) &&
				g.matcher === spec.matcher &&
				groupHooks(g).length === 1,
		),
	);
}

function stripRoots(groups: readonly unknown[]): unknown[] {
	const out: unknown[] = [];
	for (const g of groups) {
		if (!isObject(g) || !Array.isArray(g.hooks)) {
			out.push(g);
			continue;
		}
		const kept = g.hooks.filter((h) => !isRootsHandler(h));
		if (kept.length === g.hooks.length) out.push(g);
		else if (kept.length > 0) out.push({ ...g, hooks: kept });
	}
	return out;
}

export class SettingsShapeError extends Error {}

function hooksOf(settings: Json): Json {
	const hooks = settings.hooks;
	if (hooks === undefined) return {};
	if (!isObject(hooks)) throw new SettingsShapeError("`hooks` is not an object");
	return hooks;
}

function syncEvent(hooks: Json, event: HookEvent, specs: readonly RootsHookSpec[]): boolean {
	const current = hooks[event];
	if (current !== undefined && !Array.isArray(current)) {
		throw new SettingsShapeError(`\`hooks.${event}\` is not an array`);
	}
	const groups = current ?? [];
	if (alreadyInstalled(groups, specs)) return false;
	const next = [...stripRoots(groups), ...specs.map(makeGroup)];
	if (next.length === 0) delete hooks[event];
	else hooks[event] = next;
	return true;
}

export interface MergeResult {
	settings: Json;
	changed: boolean;
}

/**
 * Make the roots handlers in `settings` exactly `wanted` (an empty list
 * removes them all). Does not mutate the input.
 */
export function syncRootsHooks(settings: Json, wanted: readonly RootsHookSpec[]): MergeResult {
	const next: Json = structuredClone(settings);
	const hooks = hooksOf(next);
	let changed = false;
	for (const event of MANAGED_EVENTS) {
		const specs = wanted.filter((w) => w.event === event);
		if (hooks[event] === undefined && specs.length === 0) continue;
		if (syncEvent(hooks, event, specs)) changed = true;
	}
	if (!changed) return { settings, changed: false };
	if (Object.keys(hooks).length === 0) delete next.hooks;
	else next.hooks = hooks;
	return { settings: next, changed: true };
}

function groupRootsHooks(event: HookEvent, g: unknown): RootsHookSpec[] {
	const matcher = isObject(g) && typeof g.matcher === "string" ? g.matcher : undefined;
	return groupHooks(g)
		.filter(isRootsHandler)
		.map((h) => ({
			event,
			command: String(isObject(h) ? h.command : ""),
			...(matcher ? { matcher } : {}),
		}));
}

/** Roots handlers currently in `settings` (for reporting). */
export function installedRootsHooks(settings: Json): RootsHookSpec[] {
	const hooks = isObject(settings.hooks) ? settings.hooks : {};
	return MANAGED_EVENTS.flatMap((event) => {
		const groups = hooks[event];
		return Array.isArray(groups) ? groups.flatMap((g) => groupRootsHooks(event, g)) : [];
	});
}
