// JSONL storage: advisory locks, atomic writes, dedup-on-read (last wins).
//
// Pattern follows ../seeds/src/store.ts. Every .luuna/roots/*.jsonl file is
// `merge=union` in git, so a file may contain several versions of the same
// record after a merge; readers dedup by id and the LAST occurrence wins.
// Writers that rewrite a file compact it to one line per id.
//
// Locking: `<file>.lock` created with O_EXCL. Stale locks (older than
// LOCK_STALE_MS) are reclaimed via atomic rename to a sidecar so two
// reclaimers can never both win. Callers wrap read-modify-write sequences in
// withLock(file, fn).

import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const LOCK_STALE_MS = 30_000;
export const LOCK_RETRY_MS = 25;
export const LOCK_TIMEOUT_MS = 30_000;

export interface LockOptions {
	staleMs?: number;
	timeoutMs?: number;
}

function lockPath(file: string): string {
	return `${file}.lock`;
}

function tryUnlink(p: string): void {
	try {
		unlinkSync(p);
	} catch {
		// best effort
	}
}

function reclaimStaleLock(lock: string, seen: { ino: number; mtimeMs: number }): void {
	const sidecar = `${lock}.stale.${randomBytes(6).toString("hex")}`;
	try {
		renameSync(lock, sidecar);
	} catch {
		return; // someone else won the rename
	}
	try {
		const st = statSync(sidecar);
		if (st.ino === seen.ino && st.mtimeMs === seen.mtimeMs) {
			tryUnlink(sidecar);
			return;
		}
		renameSync(sidecar, lock); // it was a fresh lock after all: put it back
	} catch {
		tryUnlink(sidecar);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function tryCreateLock(lock: string): boolean {
	try {
		closeSync(openSync(lock, "wx"));
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		return false;
	}
}

/** True when the lock was stale and has been reclaimed (retry immediately). */
function reclaimIfStale(lock: string, staleMs: number): boolean {
	try {
		const st = statSync(lock);
		if (Date.now() - st.mtimeMs <= staleMs) return false;
		reclaimStaleLock(lock, st);
		return true;
	} catch {
		return true; // vanished between open and stat
	}
}

export async function acquireLock(file: string, opts: LockOptions = {}): Promise<void> {
	const lock = lockPath(file);
	const staleMs = opts.staleMs ?? LOCK_STALE_MS;
	const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
	const start = Date.now();
	mkdirSync(dirname(file), { recursive: true });
	while (!tryCreateLock(lock)) {
		if (reclaimIfStale(lock, staleMs)) continue;
		if (Date.now() - start > timeoutMs) throw new Error(`timeout acquiring lock for ${file}`);
		await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
	}
}

export function releaseLock(file: string): void {
	tryUnlink(lockPath(file));
}

export async function withLock<T>(
	file: string,
	fn: () => Promise<T> | T,
	opts?: LockOptions,
): Promise<T> {
	await acquireLock(file, opts);
	try {
		return await fn();
	} finally {
		releaseLock(file);
	}
}

/** Write via temp file + rename so readers never see a partial file. */
export async function atomicWrite(file: string, content: string): Promise<void> {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${randomBytes(4).toString("hex")}`;
	writeFileSync(tmp, content);
	try {
		renameSync(tmp, file);
	} catch (err) {
		tryUnlink(tmp);
		throw err;
	}
}

/** Parse JSONL, skipping blank and malformed lines. */
export function parseJsonl<T>(content: string): T[] {
	const out: T[] = [];
	for (const line of content.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const v: unknown = JSON.parse(t);
			if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(v as T);
		} catch {
			// skip malformed line (e.g. a merge conflict marker)
		}
	}
	return out;
}

/** Dedup by `key`, last occurrence wins, preserving first-seen order. */
export function dedupBy<T>(items: T[], key: (item: T) => string): T[] {
	const map = new Map<string, T>();
	for (const item of items) map.set(key(item), item);
	return [...map.values()];
}

export function dedupById<T extends { id: string }>(items: T[]): T[] {
	return dedupBy(items, (i) => i.id);
}

export function readJsonlFile<T>(file: string): T[] {
	if (!existsSync(file)) return [];
	return parseJsonl<T>(readFileSync(file, "utf8"));
}

export function serializeJsonl(records: readonly unknown[]): string {
	return records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** Rewrite a JSONL file atomically. Caller must hold withLock(file). */
export async function writeJsonlFile(file: string, records: readonly unknown[]): Promise<void> {
	await atomicWrite(file, serializeJsonl(records));
}

/** Append records atomically (read + temp + rename). Caller must hold withLock(file). */
export async function appendJsonlFile(file: string, records: readonly unknown[]): Promise<void> {
	if (records.length === 0) return;
	const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
	const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
	await atomicWrite(file, prefix + serializeJsonl(records));
}

/** Read an id-keyed table (proposals, questions): dedup last-wins. */
export function readTable<T extends { id: string }>(file: string): T[] {
	return dedupById(readJsonlFile<T>(file));
}

/**
 * Locked read-modify-write of an id-keyed table. `fn` mutates or replaces the
 * rows; the file is rewritten (compacted) only when `fn` returns `write: true`.
 */
export async function updateTable<T extends { id: string }, R>(
	file: string,
	fn: (
		rows: T[],
	) => Promise<{ rows: T[]; write: boolean; result: R }> | { rows: T[]; write: boolean; result: R },
): Promise<R> {
	return withLock(file, async () => {
		const { rows, write, result } = await fn(readTable<T>(file));
		if (write) await writeJsonlFile(file, dedupById(rows));
		return result;
	});
}
