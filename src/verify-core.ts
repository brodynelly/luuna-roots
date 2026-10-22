// Shared types and helpers for `luuna-roots verify` (verify.ts, verify-boundary.ts).

import { existsSync, readFileSync } from "node:fs";
import type { GitProbe } from "./git-trust.ts";
import type { RootsPaths } from "./paths.ts";
import type { NodeDirs } from "./prose.ts";
import type { EventRecord, Graph, ProposalRecord, QuestionRecord } from "./types.ts";

export type Severity = "error" | "warning";

export interface VerifyIssue {
	code: string;
	severity: Severity;
	message: string;
	/** Relative to the project root. */
	file?: string;
	line?: number;
	node?: string;
	edge?: string;
	id?: string;
}

export interface VerifyContext {
	paths: RootsPaths;
	graph: Graph;
	dirs: NodeDirs;
	events: EventRecord[];
	proposals: ProposalRecord[];
	questions: QuestionRecord[];
	git: GitProbe;
	/** Issues found while reading the files (parse errors, invalid records). */
	readIssues: VerifyIssue[];
}

export type VerifyCheck = (ctx: VerifyContext) => VerifyIssue[];

export function issue(
	code: string,
	severity: Severity,
	message: string,
	at: Omit<VerifyIssue, "code" | "severity" | "message"> = {},
): VerifyIssue {
	return { code, severity, message, ...at };
}

export interface JsonlRow {
	line: number;
	value: Record<string, unknown>;
}

/**
 * Parse a JSONL file keeping line numbers (1-based). Lines that are not a
 * JSON object become `jsonl.parse` errors (e.g. merge conflict markers).
 */
export function scanJsonl(file: string, rel: string, issues: VerifyIssue[]): JsonlRow[] {
	if (!existsSync(file)) return [];
	const rows: JsonlRow[] = [];
	readFileSync(file, "utf8")
		.split("\n")
		.forEach((raw, i) => {
			const text = raw.trim();
			if (text === "") return;
			let v: unknown;
			try {
				v = JSON.parse(text);
			} catch {
				v = undefined;
			}
			if (typeof v === "object" && v !== null && !Array.isArray(v)) {
				rows.push({ line: i + 1, value: v as Record<string, unknown> });
			} else {
				const preview = text.length > 40 ? `${text.slice(0, 39)}…` : text;
				issues.push(
					issue("jsonl.parse", "error", `${rel}:${i + 1} is not a JSON object: ${preview}`, {
						file: rel,
						line: i + 1,
					}),
				);
			}
		});
	return rows;
}
