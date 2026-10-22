// Typed errors and exit codes for the roots CLI.
//
// Every error a command raises on purpose is a RootsError. The CLI entry maps
// it to a stable exit code and a machine-readable `code` in --json output.
// Anything else is an internal error (exit 1).

export const EXIT = {
	ok: 0,
	error: 1,
	usage: 2,
	notFound: 3,
	guard: 4,
	conflict: 5,
	validation: 6,
} as const;

export type ErrorCode =
	| "error"
	| "cancelled"
	| "usage"
	| "ambiguous"
	| "not_found"
	| "not_initialized"
	| "guard"
	| "conflict"
	| "validation"
	| "config";

export class RootsError extends Error {
	readonly code: ErrorCode;
	readonly exitCode: number;
	/** Optional structured detail merged into the --json error envelope. */
	readonly detail: Record<string, unknown> | undefined;

	constructor(
		message: string,
		code: ErrorCode = "error",
		exitCode: number = EXIT.error,
		detail?: Record<string, unknown>,
	) {
		super(message);
		this.name = "RootsError";
		this.code = code;
		this.exitCode = exitCode;
		this.detail = detail;
	}
}

/** Bad arguments, unknown flags, invalid values. */
export class UsageError extends RootsError {
	constructor(message: string, detail?: Record<string, unknown>) {
		super(message, "usage", EXIT.usage, detail);
		this.name = "UsageError";
	}
}

/** A node reference matched more than one node. */
export class AmbiguousError extends RootsError {
	constructor(message: string, candidates: string[]) {
		super(message, "ambiguous", EXIT.usage, { candidates });
		this.name = "AmbiguousError";
	}
}

export class NotFoundError extends RootsError {
	constructor(message: string, detail?: Record<string, unknown>) {
		super(message, "not_found", EXIT.notFound, detail);
		this.name = "NotFoundError";
	}
}

export class NotInitializedError extends RootsError {
	constructor(cwd: string) {
		super(
			`not a roots project (no .luuna/roots/ found from ${cwd}); run \`luuna-roots init\``,
			"not_initialized",
			EXIT.notFound,
		);
		this.name = "NotInitializedError";
	}
}

/** Human/agent boundary guards: TTY required, actor unresolvable or not allowed. */
export class GuardError extends RootsError {
	constructor(message: string) {
		super(message, "guard", EXIT.guard);
		this.name = "GuardError";
	}
}

export class ConflictError extends RootsError {
	constructor(message: string, detail?: Record<string, unknown>) {
		super(message, "conflict", EXIT.conflict, detail);
		this.name = "ConflictError";
	}
}

export class ValidationError extends RootsError {
	constructor(message: string, detail?: Record<string, unknown>) {
		super(message, "validation", EXIT.validation, detail);
		this.name = "ValidationError";
	}
}

export class ConfigError extends RootsError {
	constructor(message: string) {
		super(message, "config", EXIT.validation);
		this.name = "ConfigError";
	}
}

/** The human backed out (e.g. saved an empty file in $EDITOR). */
export class CancelledError extends RootsError {
	constructor(message: string) {
		super(message, "cancelled", EXIT.error);
		this.name = "CancelledError";
	}
}
