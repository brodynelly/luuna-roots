// Running the user-configured agent.command (roots-e3a2). roots contains no LLM (AGENTS.md invariant 2): this is the only
// place it starts an agent, and only the command the user configured.
//
// The command runs through `/bin/sh -c` in the project root, in its own
// process group (so a timeout kills the whole tree). stdin gets
// AGENT_INSTRUCTION followed by the Markdown context packet. The agent
// answers by calling `luuna-roots ask`, which validates every question; its stdout
// is ignored except as a diagnostic tail. Env:
//   ROOTS_AGENT    agent:<model> — the identity its `luuna-roots ask` calls use
//   ROOTS_SESSION  the think session, so asks attach to it
//   ROOTS_NODE     the idea id
//   ROOTS_FLOW     the flow session (heading runs only)
// ROOTS_USER and the test-only TTY override are removed from its env.
//
// Failure never blocks thinking: non-zero exit, a spawn error or a timeout
// come back as a result, never as a throw.

import { spawn } from "node:child_process";
import { type ContextPacket, renderContextMarkdown } from "./context.ts";
import { kebab } from "./slug.ts";
import type { Actor } from "./types.ts";

/**
 * The fixed instruction sent ahead of the context packet. Placeholders:
 * {{id}} {{slug}} {{asks}} {{actor}} {{max}}.
 */
export const AGENT_INSTRUCTION = `You are helping a human think about one idea in their project. The idea and
its context (neighbors, earlier questions, rejected proposals, repo state) are below.

Your only job: ask up to {{asks}} questions that will help the human sharpen THIS idea.
Ask each question by running this shell command, once per question:

  luuna-roots ask {{id}} "<your question>" --as {{actor}}

Rules:
- Ask questions only. Do not create, edit or delete any file, and never touch .luuna/roots/human/.
  The human answers by rewriting the idea in their own words.
- Be specific to this idea: its claims, edge cases, trade-offs, what "done" means, how it
  conflicts with its neighbors or with the repo. Never ask a generic question that would fit
  any idea ("What are the risks?").
- One question per command: one sentence, ending with "?", at most {{max}} characters.
- Never repeat or rephrase a question under "Prior questions". A dismissed question is one
  the human refused; do not ask anything close to it.
- If \`luuna-roots ask\` fails, read its error, then fix the question or move on. Stop after
  {{asks}} successful asks.
- Fewer sharp questions beat more weak ones. If nothing useful comes to mind, ask nothing.
- When you are done, exit. roots ignores anything you print.
`;

export const DEFAULT_KILL_GRACE_MS = 1000;
const OUTPUT_TAIL = 4000;

export interface AgentPromptOptions {
	actor: Actor;
	/** How many asks the cap allows. */
	asks: number;
}

export function agentPrompt(packet: ContextPacket, opts: AgentPromptOptions): string {
	const vars: Record<string, string> = {
		id: packet.node.id,
		slug: packet.node.slug,
		asks: String(opts.asks),
		actor: opts.actor,
		max: String(packet.limits.questionMaxLength),
	};
	const head = AGENT_INSTRUCTION.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
	return `${head}\n---\n\n${renderContextMarkdown(packet)}`;
}

/**
 * The actor the configured agent acts as: `--model <m>` / `--model=<m>` in
 * the command, else the program name (`claude -p` → agent:claude).
 */
export function agentActorFor(command: string): Actor {
	const model = /(?:^|\s)--model[=\s]+["']?([^\s"']+)/.exec(command)?.[1];
	const program = command.trim().split(/\s+/)[0] ?? "";
	const name = kebab(model ?? program.split("/").pop() ?? "") || "agent";
	return `agent:${name}`;
}

export function agentEnv(
	base: Record<string, string | undefined>,
	vars: { actor: Actor; session?: string; node?: string; flow?: string },
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) {
		if (v === undefined || k === "ROOTS_USER" || k === "LUUNA_ROOTS_USER" || k === "ROOTS_FORCE_TTY") continue;
		if (k === "ROOTS_SESSION" || k === "ROOTS_NODE" || k === "ROOTS_FLOW") continue;
		env[k] = v;
	}
	env.ROOTS_AGENT = vars.actor;
	env.LUUNA_ROOTS_AGENT = vars.actor;
	if (vars.session) env.ROOTS_SESSION = vars.session;
	if (vars.node) env.ROOTS_NODE = vars.node;
	if (vars.flow) env.ROOTS_FLOW = vars.flow;
	return env;
}

export type AgentRunStatus = "ok" | "failed" | "timeout" | "error";

export interface AgentRunResult {
	status: AgentRunStatus;
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	/** Last few KB of stdout+stderr, for diagnostics. */
	output: string;
	/** Human-readable reason when status is not ok. */
	error: string | null;
}

export interface RunAgentOptions {
	command: string;
	cwd: string;
	input: string;
	env: Record<string, string>;
	timeoutMs: number;
	killGraceMs?: number;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

function describe(r: Omit<AgentRunResult, "error">, timeoutMs: number): string | null {
	if (r.status === "ok") return null;
	if (r.status === "timeout") {
		const t = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
		return `timed out after ${t}`;
	}
	if (r.signal) return `killed by ${r.signal}`;
	return `exited with code ${r.exitCode}`;
}

/** Run agent.command once. Never throws; never rejects. */
export function runAgentCommand(opts: RunAgentOptions): Promise<AgentRunResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		let settled = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const finish = (r: Omit<AgentRunResult, "durationMs" | "output">) => {
			if (settled) return;
			settled = true;
			for (const t of timers) clearTimeout(t);
			resolve({ ...r, durationMs: Date.now() - started, output: output.slice(-OUTPUT_TAIL) });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("/bin/sh", ["-c", opts.command], {
				cwd: opts.cwd,
				env: opts.env,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			finish({ status: "error", exitCode: null, signal: null, error: msg });
			return;
		}
		const collect = (d: Buffer) => {
			output = (output + d.toString("utf8")).slice(-OUTPUT_TAIL * 2);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.stdin?.on("error", () => {
			// the agent may exit without reading stdin
		});
		child.stdin?.end(opts.input);
		child.on("error", (err) => {
			finish({ status: "error", exitCode: null, signal: null, error: err.message });
		});
		child.on("close", (code, signal) => {
			const status: AgentRunStatus = timedOut ? "timeout" : code === 0 ? "ok" : "failed";
			const base = { status, exitCode: code, signal: signal ?? null };
			finish({ ...base, error: describe({ ...base, durationMs: 0, output }, opts.timeoutMs) });
		});
		const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
		timers.push(
			setTimeout(() => {
				timedOut = true;
				killGroup(child.pid, "SIGTERM");
				timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), grace));
				// Give up waiting for pipes held open by stray grandchildren.
				timers.push(
					setTimeout(() => {
						const error = describe(
							{ status: "timeout", exitCode: null, signal: null, durationMs: 0, output },
							opts.timeoutMs,
						);
						finish({ status: "timeout", exitCode: null, signal: "SIGKILL", error });
					}, grace * 2),
				);
			}, opts.timeoutMs),
		);
	});
}
