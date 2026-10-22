# Roots Operations Runbook

Procedures only. For conventions see `AGENTS.md`; for direction see seeds (`lms ready`). Read each section as
"run X; if Y, then Z".

Roots is pre-release (`"private": true`, version `0.0.0`). There is no publish workflow yet, so
there is no release or npm rollback procedure. Add one (mirroring `../seeds/RUNBOOK.md`) with the
first publish.

## 1. A gate fails (`bun run verify` or CI)

1. Read the failure block. `check:all` prints only the failing gate names, parsed failure
   signatures and a `re-run: bun run <gate>` hint.
2. Re-run that one gate: `bun run <gate>`. For full output of every gate:
   `CHECK_ALL_VERBOSE=1 bun run check:all`.
3. Per gate:
   - `lint`: `bun run lint:fix`, then fix what remains by hand. Never reformat
     `scripts/check-all.ts` or `scripts/check-ci-parity.ts` (byte-identical fleet copies; Biome's
     formatter is off for them).
   - `typecheck`: fix the type error. Do not add `any` or non-null assertions.
   - `check:agents`: a `bun run <x>` or a backticked path in `AGENTS.md` no longer exists. Fix
     `AGENTS.md`, or add a justified `--known-missing` in the `check:agents` script.
   - `check:dups`: extract the shared code. The threshold is in `.jscpd.json`.
   - `check:deps`: remove the unused dev dependency, or declare the missing one. Runtime
     dependencies are not allowed.
   - `check:size`: split the file. Do not raise `scripts/file-size-budgets.json`.
   - `check:debt`: add a tracker reference (`roots-xxxx`, `#123`, a URL) to the TODO/FIXME, or
     remove it.
   - `check:coverage`: a test failed (see its `(fail)` line) or coverage fell below
     `scripts/coverage-budgets.json`. Add tests. Raise the floors when coverage goes up.
   - `check:ci-parity`: `.github/workflows/ci.yml` and the gate manifest drifted. Every gate needs
     a `bun run <gate>` step in CI, and every CI `bun run` must be reachable from `check:all` (or
     listed in `scripts/ci-parity-config.json` with a justification).

## 2. A test fails only sometimes

1. Loop it: `for i in $(seq 1 40); do bun test <file> 2>&1 | grep '(fail)'; done`.
2. Add CPU load while looping (`yes > /dev/null &` once per core; `pkill yes` after).
   Timing bugs usually show only under load.
3. Usual cause: `fs.watch` on macOS drops events for a short time after the watch starts. Wait
   until the watcher is live (see `armed()` in `src/watch.test.ts`), not a fixed sleep. For TUI
   tests, wait on screen content with `waitFor()` from `src/test-helpers.ts`.
4. Fix the test or the code. Do not add retries.

## 3. A project's `.luuna/roots/` looks wrong

1. Run `luuna-roots verify` (exit 6 on errors). It reports boundary breaks, bad authors, graph
   invariant breaks, dangling references, malformed JSONL lines and human files changed outside
   a session.
2. **Merge conflict in `*.jsonl`:** there should be none, because `luuna-roots init` adds
   `.luuna/roots/*.jsonl merge=union` to `.gitattributes`. If the line is missing, add it, keep both
   sides of the conflict and run `luuna-roots verify`. Duplicate records are fine: reads keep the last
   occurrence.
3. **A command hangs on a lock:** a crashed process left `<file>.lock`. Stale locks are reclaimed
   automatically after the stale timeout (see `src/store.ts`). If one persists and no `roots`
   process is running, delete the `.lock` file.
4. **Human prose changed outside a session:** `verify` reports it through the hash ledger. If a
   human made the edit, commit it (a human-authored commit clears it) or run a `luuna-roots think`
   session. If an agent made it, restore the file from git.
5. Never hand-edit `graph.jsonl`, `proposals.jsonl` or `events.jsonl` to change decisions. Use
   the CLI so each change logs one event.

## 4. Roll back a bad change

Roots does not commit for you. Revert the offending commit on `main` with `git revert <sha>`,
run `bun run verify`, and open a PR. `.luuna/roots/` data in user projects is plain git history:
restore it with `git checkout <sha> -- .luuna/roots/`.
