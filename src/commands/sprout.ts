// luuna-roots sprout <statement> [--file <md>] [--slug <s>] --as agent:<model>
// (agent, tier ≥ 2): propose a new idea in the agent tree. Writes only
// .luuna/roots/agent/sprouts/<hex>-<slug>/sprout.md. See src/sprouts.ts for every
// check (cap, dedup, permanent rejections, expiry).

import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { resolveAgentActor } from "../actor.ts";
import { flagString } from "../args.ts";
import { NotFoundError, UsageError, ValidationError } from "../errors.ts";
import type { CommandDef } from "../registry.ts";
import { fileSprout, SPROUT_BODY_MAX_BYTES } from "../sprouts.ts";
import { daysLeft } from "../tend.ts";
import { openWorkspace } from "../workspace.ts";

function readBody(cwd: string, file: string | undefined): string | undefined {
	if (file === undefined) return undefined;
	const path = resolve(cwd, file);
	let size: number;
	try {
		const st = statSync(path);
		if (!st.isFile()) throw new UsageError(`--file ${file} is not a regular file`);
		size = st.size;
	} catch (err) {
		if (err instanceof UsageError) throw err;
		throw new NotFoundError(`--file ${file}: no such file`);
	}
	if (size > SPROUT_BODY_MAX_BYTES) {
		throw new ValidationError(
			`--file is ${size} bytes; the limit is ${SPROUT_BODY_MAX_BYTES}. Attach long material with \`luuna-roots note\``,
		);
	}
	return readFileSync(path, "utf8");
}

export const sproutCommand: CommandDef = {
	name: "sprout",
	group: "agent",
	summary: "Propose a new idea in the agent tree (tier ≥ 2)",
	usage: "sprout <statement> [--file <md>]",
	description:
		"The statement is one claim in one line. --file adds prose after it (Markdown).\n" +
		"A sprout never becomes an idea: a human may adopt it (they rewrite it in their own\n" +
		"words) or reject it, in `luuna-roots tend`. Refused below tier 2, at limits.sprouts open\n" +
		"sprouts, or when the statement matches an idea, an open or adopted sprout, or a\n" +
		"rejected one (rejections are permanent). Open sprouts expire after\n" +
		"limits.sproutTtlDays.",
	flags: {
		file: { type: "string", placeholder: "<md>", description: "Prose after the statement" },
		slug: { type: "string", placeholder: "<slug>", description: "Slug (default: from statement)" },
		as: {
			type: "string",
			placeholder: "agent:<model>",
			description: "Agent identity (default: $ROOTS_AGENT)",
		},
	},
	minArgs: 1,
	async run({ io, out, args, flags }) {
		const by = resolveAgentActor(flagString(flags, "as"), io);
		const ws = await openWorkspace(io.cwd);
		const r = await fileSprout(ws.paths, {
			statement: args.join(" "),
			body: readBody(io.cwd, flagString(flags, "file")),
			slug: flagString(flags, "slug"),
			by,
		});
		const path = relative(ws.paths.root, r.file);
		await out.result({
			id: r.node.id,
			slug: r.node.slug,
			status: r.node.status,
			author: by,
			path,
			statement: r.statement,
			expiresAt: r.node.expiresAt,
		});
		const days = daysLeft(r.node.expiresAt ?? null, new Date());
		await out.success(`sprouted ${out.c.id(r.node.id)} ${r.node.slug}`);
		await out.info(
			`  ${out.c.dim(`${path} · expires in ${days}d · a human decides in \`luuna-roots tend\``)}`,
		);
	},
};
