// .luuna/roots/config.yaml: load with defaults, validate, write.

import { existsSync, readFileSync } from "node:fs";
import { ConfigError } from "./errors.ts";
import type { RootsPaths } from "./paths.ts";
import { atomicWrite } from "./store.ts";
import { parseYaml, stringifyYaml, type YamlMap, type YamlValue } from "./yaml.ts";

export type Tier = 0 | 1 | 2 | 3;

export interface RootsConfig {
	project: string;
	version: string;
	tier: Tier;
	agent: {
		command: string | null;
		/** `think` gives up on agent.command after this many seconds (then continues). */
		timeoutSeconds: number;
	};
	limits: {
		proposals: number;
		sprouts: number;
		questionsPerSession: number;
		proposalTtlDays: number;
		sproutTtlDays: number;
	};
	/** Thresholds for the deterministic question rules (see src/rules.ts). */
	questions: QuestionThresholds;
	view: { write: boolean };
	/** `luuna-roots flow`: heading = ask the agent where the session is going. */
	flow: { heading: boolean };
}

export interface QuestionThresholds {
	/** missing-done: ask from the Nth think session on (1 = the first session). */
	doneAfterSessions: number;
	/** too-big: body (after the statement) longer than N non-empty lines. */
	bigBodyLines: number;
	/** orphan: no edges N days after planting. */
	orphanAfterDays: number;
	/** stale: committed and not touched by a human for N days. */
	staleAfterDays: number;
	/** `z` in a think session hides a question for N days. */
	snoozeDays: number;
}

export const DEFAULT_QUESTION_THRESHOLDS: QuestionThresholds = {
	doneAfterSessions: 1,
	bigBodyLines: 30,
	orphanAfterDays: 3,
	staleAfterDays: 30,
	snoozeDays: 7,
};

export const CONFIG_VERSION = "1";
export const DEFAULT_AGENT_TIMEOUT_SECONDS = 120;

/** Default config values. */
export function defaultConfig(project: string): RootsConfig {
	return {
		project,
		version: CONFIG_VERSION,
		tier: 2,
		agent: { command: null, timeoutSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS },
		limits: {
			proposals: 10,
			sprouts: 5,
			questionsPerSession: 3,
			proposalTtlDays: 14,
			sproutTtlDays: 30,
		},
		questions: { ...DEFAULT_QUESTION_THRESHOLDS },
		view: { write: false },
		flow: { heading: true },
	};
}

function asMap(v: YamlValue | undefined, field: string): YamlMap {
	if (v === undefined || v === null) return {};
	if (typeof v !== "object" || Array.isArray(v)) {
		throw new ConfigError(`config.yaml: \`${field}\` must be a mapping`);
	}
	return v;
}

function readInt(map: YamlMap, key: string, field: string, fallback: number, min = 0): number {
	const v = map[key];
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
		throw new ConfigError(`config.yaml: \`${field}\` must be an integer >= ${min}`);
	}
	return v;
}

function readString(map: YamlMap, key: string, field: string, fallback: string): string {
	const v = map[key];
	if (v === undefined || v === null) return fallback;
	if (typeof v === "number") return String(v);
	if (typeof v !== "string") throw new ConfigError(`config.yaml: \`${field}\` must be a string`);
	return v;
}

function readBool(map: YamlMap, key: string, field: string, fallback: boolean): boolean {
	const v = map[key];
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "boolean")
		throw new ConfigError(`config.yaml: \`${field}\` must be true or false`);
	return v;
}

function readTier(map: YamlMap, fallback: Tier): Tier {
	const t = readInt(map, "tier", "tier", fallback);
	if (t > 3) throw new ConfigError("config.yaml: `tier` must be 0, 1, 2 or 3");
	return t as Tier;
}

function readLimits(map: YamlMap, d: RootsConfig["limits"]): RootsConfig["limits"] {
	const f = (k: keyof RootsConfig["limits"], min = 0) => readInt(map, k, `limits.${k}`, d[k], min);
	return {
		proposals: f("proposals"),
		sprouts: f("sprouts"),
		questionsPerSession: f("questionsPerSession"),
		proposalTtlDays: f("proposalTtlDays", 1),
		sproutTtlDays: f("sproutTtlDays", 1),
	};
}

function readQuestions(map: YamlMap, d: QuestionThresholds): QuestionThresholds {
	const f = (k: keyof QuestionThresholds, min = 0) => readInt(map, k, `questions.${k}`, d[k], min);
	return {
		doneAfterSessions: f("doneAfterSessions"),
		bigBodyLines: f("bigBodyLines", 1),
		orphanAfterDays: f("orphanAfterDays"),
		staleAfterDays: f("staleAfterDays", 1),
		snoozeDays: f("snoozeDays", 1),
	};
}

function readAgentCommand(map: YamlMap): string | null {
	const v = map.command;
	if (v === undefined || v === null || v === "") return null;
	if (typeof v !== "string") throw new ConfigError("config.yaml: `agent.command` must be a string");
	return v;
}

function readAgent(map: YamlMap, d: RootsConfig["agent"]): RootsConfig["agent"] {
	return {
		command: readAgentCommand(map),
		timeoutSeconds: readInt(map, "timeoutSeconds", "agent.timeoutSeconds", d.timeoutSeconds, 1),
	};
}

/** Merge a parsed YAML document over defaults, validating every field. */
export function configFromYaml(doc: YamlMap, fallbackProject: string): RootsConfig {
	const d = defaultConfig(fallbackProject);
	return {
		project: readString(doc, "project", "project", d.project),
		version: readString(doc, "version", "version", d.version),
		tier: readTier(doc, d.tier),
		agent: readAgent(asMap(doc.agent, "agent"), d.agent),
		limits: readLimits(asMap(doc.limits, "limits"), d.limits),
		questions: readQuestions(asMap(doc.questions, "questions"), d.questions),
		view: { write: readBool(asMap(doc.view, "view"), "write", "view.write", d.view.write) },
		flow: {
			heading: readBool(asMap(doc.flow, "flow"), "heading", "flow.heading", d.flow.heading),
		},
	};
}

export function parseConfig(text: string, fallbackProject: string): RootsConfig {
	let doc: YamlMap;
	try {
		doc = parseYaml(text);
	} catch (err) {
		throw new ConfigError(`config.yaml: ${err instanceof Error ? err.message : String(err)}`);
	}
	return configFromYaml(doc, fallbackProject);
}

export function loadConfig(paths: RootsPaths): RootsConfig {
	const project = paths.root.split(/[\\/]/).pop() || "project";
	if (!existsSync(paths.config)) return defaultConfig(project);
	return parseConfig(readFileSync(paths.config, "utf8"), project);
}

function toYaml(config: RootsConfig): YamlMap {
	const agent: YamlMap = config.agent.command ? { command: config.agent.command } : {};
	if (config.agent.timeoutSeconds !== DEFAULT_AGENT_TIMEOUT_SECONDS) {
		agent.timeoutSeconds = config.agent.timeoutSeconds;
	}
	return {
		project: config.project,
		version: config.version,
		tier: config.tier,
		agent,
		limits: { ...config.limits },
		questions: { ...config.questions },
		view: { ...config.view },
		flow: { ...config.flow },
	};
}

export function renderConfig(config: RootsConfig): string {
	return stringifyYaml(toYaml(config));
}

/** Commented config written by `luuna-roots init`. Parses back to `config`. */
export function renderInitialConfig(config: RootsConfig): string {
	const q = (s: string) => JSON.stringify(s);
	const command = config.agent.command
		? `  command: ${q(config.agent.command)}`
		: '  # command: "claude -p --model claude-opus-5-5"   # used by `think` to get questions';
	const l = config.limits;
	const t = config.questions;
	return [
		`project: ${q(config.project)}`,
		`version: ${q(config.version)}`,
		`tier: ${config.tier}                    # 0 off, 1 ask, 2 propose, 3 observe`,
		"agent:",
		command,
		`  timeoutSeconds: ${config.agent.timeoutSeconds}      # think continues without agent questions after this`,
		"limits:",
		`  proposals: ${l.proposals}            # max pending proposals`,
		`  sprouts: ${l.sprouts}               # max open sprouts`,
		`  questionsPerSession: ${l.questionsPerSession}`,
		`  proposalTtlDays: ${l.proposalTtlDays}`,
		`  sproutTtlDays: ${l.sproutTtlDays}`,
		"questions:                 # thresholds for deterministic question rules",
		`  doneAfterSessions: ${t.doneAfterSessions}     # missing-done: ask from the Nth think session on`,
		`  bigBodyLines: ${t.bigBodyLines}         # too-big: body longer than N lines`,
		`  orphanAfterDays: ${t.orphanAfterDays}       # orphan: no edges N days after planting`,
		`  staleAfterDays: ${t.staleAfterDays}       # stale: committed, untouched for N days`,
		`  snoozeDays: ${t.snoozeDays}            # [z] in think hides a question for N days`,
		"view:",
		`  write: ${config.view.write}             # true: \`luuna-roots view\` also writes ROOTS.md`,
		"flow:",
		`  heading: ${config.flow.heading}           # \`luuna-roots flow\`: the agent says where the session is going`,
		"",
	].join("\n");
}

export async function writeConfig(paths: RootsPaths, config: RootsConfig): Promise<void> {
	await atomicWrite(paths.config, renderConfig(config));
}
