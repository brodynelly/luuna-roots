// Process I/O abstraction. Commands never touch process.* directly; they get
// an Io so the whole CLI can run in-process under test with captured output.

import { processTerminal, type Terminal } from "./terminal.ts";

export interface Io {
	cwd: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void | Promise<void>;
	stderr: (text: string) => void;
	/** True when stdin is an interactive terminal. */
	stdinIsTTY: boolean;
	/** True when stdout is an interactive terminal (enables color). */
	stdoutIsTTY: boolean;
	/** Interactive screen + raw key input (think). Tests inject a fake. */
	terminal?: Terminal;
	/** All of stdin as text (hook handlers like `luuna-roots guard`). Tests inject a string. */
	readStdin?: () => Promise<string>;
}

function isEpipe(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EPIPE";
}

async function writeProcessStdout(text: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const flushed = process.stdout.write(text, (err) => {
			if (!err) return;
			if (isEpipe(err)) process.exit(0);
			reject(err);
		});
		if (flushed) resolve();
		else process.stdout.once("drain", resolve);
	});
}

export function processIo(): Io {
	return {
		cwd: process.cwd(),
		env: process.env,
		stdout: writeProcessStdout,
		stderr: (text) => {
			process.stderr.write(text);
		},
		stdinIsTTY: process.stdin.isTTY === true,
		stdoutIsTTY: process.stdout.isTTY === true,
		terminal: processTerminal(),
		readStdin: () => Bun.stdin.text(),
	};
}
