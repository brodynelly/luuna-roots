# Luuna Roots repository guidance

Luuna Roots is the Luuna-maintained, MIT-licensed adaptation of jayminwest/roots. Preserve upstream attribution, human authorship, and accepted-graph semantics. Read `README.md` and `UPSTREAM.md` before changing storage or behavior.

## Component ownership

- Roots stores human-authored project intent under `.luuna/roots/` and agent questions/proposals in its agent-owned area.
- Missions owns tickets and plans under `.luuna/missions/`.
- Atlas owns verified expertise under `.luuna/atlas/`.
- Beacon owns reusable prompts under `.luuna/beacon/`.
- Luuna's Rust runtime owns approvals, scope, checks, review, persistence, and publication for managed runs.

No agent may write `.luuna/roots/human/`, accept its own proposal, or claim that a prompt or Roots record grants runtime permission. The CLI's human actor checks and Claude hook are useful defenses but are not substitutes for Luuna runtime policy.

## Code layout

`src/index.ts` starts the Bun CLI, `src/cli.ts` routes commands, `src/register-all.ts` registers them, `src/paths.ts` resolves the Roots store, `src/store.ts` owns JSONL operations, `src/actor.ts` enforces actor identity, and `src/hook-guard.ts` guards human-authored files. `src/seeds-link.ts` and `src/mulch-link.ts` are inherited filenames that currently read Luuna Missions and Atlas stores; rename these modules only with a compatibility review.

For any path or format change, inspect source readers, writers, hook guards, CLI help, and affected callers together. Preserve legacy data through an explicit migration instead of treating a renamed directory as an automatic upgrade. Do not hand-edit project JSONL records.
