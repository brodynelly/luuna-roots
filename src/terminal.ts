// The interactive terminal used by `luuna-roots think`: raw-mode key input and a
// full-screen redraw area. Commands get a Terminal through Io so tests can
// inject a fake one (see test-helpers.fakeTerminal) and never need a TTY.
//
// Restoration is the priority: stop() is idempotent and is called from the
// session's `finally`, from process 'exit', and SIGTERM/SIGHUP are turned
// into a quit key so the session ends cleanly (raw mode delivers Ctrl-C as a
// byte, which parseKeys also maps to quit).

export interface Terminal {
	columns(): number;
	/** Terminal height; 0 when unknown (screens then draw at natural height). */
	rows(): number;
	write(text: string): void;
	/** Enter raw mode + alternate screen and start delivering input. */
	start(onInput: (data: string) => void, onResize?: () => void): void;
	/** Leave raw mode and the alternate screen, show the cursor. Idempotent. */
	stop(): void;
}

export const ESC = {
	altOn: "\x1b[?1049h",
	altOff: "\x1b[?1049l",
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
	home: "\x1b[H",
	clear: "\x1b[2J",
} as const;

/** Full-screen frame: clear, draw lines (CRLF, since raw mode disables output translation). */
export function frame(lines: readonly string[]): string {
	return `${ESC.home}${ESC.clear}${lines.join("\r\n")}`;
}

const QUIT_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

export function processTerminal(): Terminal {
	const out = process.stdout.isTTY || !process.stderr.isTTY ? process.stdout : process.stderr;
	const stdin = process.stdin;
	let active = false;
	let onData: ((d: Buffer | string) => void) | null = null;
	let onSignal: (() => void) | null = null;
	let onResizeFn: (() => void) | null = null;

	const stop = () => {
		if (!active) return;
		active = false;
		if (onData) stdin.off("data", onData);
		if (onSignal) for (const s of QUIT_SIGNALS) process.off(s, onSignal);
		if (onResizeFn) out.off("resize", onResizeFn);
		process.off("exit", stop);
		try {
			if (stdin.isTTY) stdin.setRawMode(false);
		} catch {
			// terminal already gone
		}
		stdin.pause();
		out.write(ESC.showCursor + ESC.altOff);
	};

	return {
		columns: () => out.columns ?? 80,
		rows: () => out.rows ?? 0,
		write: (text) => {
			out.write(text);
		},
		start(onInput, onResize) {
			if (active) return;
			active = true;
			onData = (d) => onInput(typeof d === "string" ? d : d.toString("utf8"));
			onSignal = () => onInput("\x03");
			process.on("exit", stop);
			for (const s of QUIT_SIGNALS) process.on(s, onSignal);
			if (onResize) {
				onResizeFn = onResize;
				out.on("resize", onResize);
			}
			if (stdin.isTTY) stdin.setRawMode(true);
			stdin.on("data", onData);
			stdin.resume();
			out.write(ESC.altOn + ESC.hideCursor);
		},
		stop,
	};
}
