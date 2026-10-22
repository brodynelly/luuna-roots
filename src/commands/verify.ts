// luuna-roots verify [--json] (read, anyone): check the human/agent boundary, the
// idea.md hash ledger and the graph invariants. Read-only. Exits non-zero
// (validation, 6) when any error is found; warnings alone exit 0. Issue codes
// are listed in src/verify.ts.

import { ValidationError } from "../errors.ts";
import { gitProbe } from "../git-trust.ts";
import type { Output } from "../output.ts";
import { requireRootsPaths } from "../paths.ts";
import type { CommandDef } from "../registry.ts";
import { loadVerifyContext, runVerify, type VerifyIssue } from "../verify.ts";

/** file:line for record-level issues; other messages name their subject. */
function where(i: VerifyIssue): string {
	return i.file && i.line !== undefined ? `${i.file}:${i.line}` : "";
}

function issueLine(out: Output, i: VerifyIssue): string {
	const mark = i.severity === "error" ? out.c.red("✗") : out.c.yellow("!");
	const loc = where(i);
	return `${mark} ${out.c.bold(i.code)}  ${loc ? `${out.c.dim(loc)}  ` : ""}${i.message}`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export const verifyCommand: CommandDef = {
	name: "verify",
	group: "read",
	summary: "Check the human/agent boundary + graph invariants",
	usage: "verify",
	description:
		"Checks: files under .luuna/roots/human/ that are not an idea's idea.md or assets/, symlinks\n" +
		"leaving human/, idea.md edits outside a think session and not in a human commit (hash\n" +
		"ledger), authors (ideas human:*, sprouts agent:*, edges human:*, proposals agent:*/roots),\n" +
		"graph invariants, dangling references, missing/orphan directories, malformed JSONL\n" +
		"lines, events without `by`; warns when a built idea has linked seeds issues still open.\n" +
		"Exits 6 on errors; warnings are listed but pass.",
	maxArgs: 0,
	async run({ io, out }) {
		const paths = requireRootsPaths(io.cwd);
		const report = runVerify(loadVerifyContext(paths, gitProbe(paths.root, io.env)));
		const errors = report.issues.filter((i) => i.severity === "error");
		const warnings = report.issues.filter((i) => i.severity === "warning");
		const summary = `${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}`;
		if (!out.json) {
			await out.lines([...errors, ...warnings].map((i) => issueLine(out, i)));
		}
		if (report.errors > 0) {
			throw new ValidationError(`verify: ${summary}`, {
				errors: report.errors,
				warnings: report.warnings,
				issues: report.issues,
			});
		}
		await out.result({ ok: true, errors: 0, warnings: report.warnings, issues: report.issues });
		if (report.warnings > 0) await out.line(`verify: ${summary}`);
		else await out.success("verify: no problems found");
	},
};
