// Command definitions and help rendering.

import type { FlagSpecs, FlagValue } from "./args.ts";
import { type Colors, padEnd } from "./color.ts";
import type { Io } from "./io.ts";
import type { Output } from "./output.ts";

export interface CommandContext {
	io: Io;
	out: Output;
	/** Positional arguments after the command name. */
	args: string[];
	flags: Record<string, FlagValue>;
}

export type CommandGroup = "setup" | "capture" | "structure" | "agent" | "read";

export interface CommandDef {
	name: string;
	group: CommandGroup;
	summary: string;
	/** Usage line after `roots`, e.g. "show <id>". */
	usage: string;
	description?: string;
	flags?: FlagSpecs;
	minArgs?: number;
	/** Omit for unlimited. */
	maxArgs?: number;
	run: (ctx: CommandContext) => Promise<void>;
}

export const GLOBAL_FLAGS: FlagSpecs = {
	json: { type: "boolean", description: "Machine-readable JSON output" },
	quiet: { type: "boolean", short: "q", description: "Suppress non-essential output" },
	help: { type: "boolean", short: "h", description: "Show help for this command" },
};

const GROUP_TITLES: Record<CommandGroup, string> = {
	setup: "Setup",
	capture: "Capture and think (human)",
	structure: "Structure (human)",
	agent: "Agent-facing (agent)",
	read: "Read (anyone)",
};

function flagLabel(name: string, spec: FlagSpecs[string]): string {
	const short = spec.short ? `-${spec.short}, ` : "    ";
	const value = spec.type === "string" ? ` ${spec.placeholder ?? "<value>"}` : "";
	return `${short}--${name}${value}`;
}

function flagLines(specs: FlagSpecs, c: Colors): string[] {
	const entries = Object.entries(specs);
	const width = Math.max(...entries.map(([n, s]) => flagLabel(n, s).length)) + 2;
	return entries.map(([n, s]) => `  ${padEnd(c.cyan(flagLabel(n, s)), width)}${s.description}`);
}

export function renderCommandHelp(def: CommandDef, c: Colors): string {
	const lines = [`${c.bold("Usage:")} luuna-roots ${def.usage}`, "", def.summary];
	if (def.description) lines.push("", def.description);
	if (def.flags && Object.keys(def.flags).length > 0) {
		lines.push("", c.bold("Options:"), ...flagLines(def.flags, c));
	}
	lines.push("", c.bold("Global options:"), ...flagLines(GLOBAL_FLAGS, c));
	return `${lines.join("\n")}\n`;
}

const USAGE_COLUMN = 30;
const VERSION_FLAG = { type: "boolean", short: "v", description: "Print the version" } as const;

function commandLine(d: CommandDef, width: number, c: Colors): string[] {
	if (d.usage.length + 2 <= width) return [`  ${padEnd(c.cyan(d.usage), width)}${d.summary}`];
	return [`  ${c.cyan(d.usage)}`, `  ${" ".repeat(width)}${d.summary}`];
}

export function renderRootHelp(defs: readonly CommandDef[], version: string, c: Colors): string {
	const width = Math.min(USAGE_COLUMN, Math.max(...defs.map((d) => d.usage.length)) + 2);
	const lines = [
		`${c.bold("luuna-roots")} ${c.dim(`v${version}`)}: human-owned intent for Luuna projects`,
		"",
		`${c.bold("Usage:")} luuna-roots <command> [options]`,
	];
	for (const group of Object.keys(GROUP_TITLES) as CommandGroup[]) {
		const inGroup = defs.filter((d) => d.group === group);
		if (inGroup.length === 0) continue;
		lines.push("", c.bold(GROUP_TITLES[group]));
		for (const d of inGroup) lines.push(...commandLine(d, width, c));
	}
	lines.push(
		"",
		c.bold("Global options:"),
		...flagLines({ ...GLOBAL_FLAGS, version: VERSION_FLAG }, c),
		"",
		"Run `luuna-roots <command> --help` for details. Every command accepts --json.",
	);
	return `${lines.join("\n")}\n`;
}
