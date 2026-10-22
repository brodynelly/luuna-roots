#!/usr/bin/env bun
// Luuna Roots CLI entry. Keep thin: all logic lives in cli.ts and commands/.

import { runCli } from "./cli.ts";
import { processIo } from "./io.ts";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") process.exit(0);
});

process.exitCode = await runCli(process.argv.slice(2), processIo());
