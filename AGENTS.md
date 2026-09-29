# AGENTS.md

## Mission

**Roots**: git-native intent for projects. Humans write ideas. Agents ask questions and propose structure. Agents never write human intent. Direction lives in seeds (`sd ready`, what to build) and roots (the project's intent). There is no spec doc: the code, README and tests describe current behavior. If a change conflicts with recorded intent, raise it. Do not quietly pick one.

Part of os-eco. Seeds = what to do, Mulch = what we learned, Roots = why.

## Commands

```bash
bun install           # also points git at scripts/hooks (pre-commit: lint + typecheck)
bun run verify        # = check:all, the fleet gate suite; must pass before commit
bun test              # single: bun test src/foo.test.ts
bun run lint:fix
bun src/index.ts ...  # run the CLI (binary: roots)
```

## Conventions

Bun, strict TypeScript, **zero runtime deps** (devDeps only). Biome: tabs, 100 cols, kebab-case filenames. `bun test` with real I/O in temp dirs, no mocks. Put tests next to code as `*.test.ts`. Follow seeds/mulch patterns (`../seeds/src/store.ts`) for JSONL, advisory locks, atomic writes and output helpers.

## Testing & Validation Guidance

`check:all` (`scripts/check-all.ts`, byte-identical fleet runner; never edit it or
`scripts/check-ci-parity.ts`) runs, in order: lint, typecheck, check:agents, check:dups,
check:deps, check:size, check:debt, check:coverage, check:ci-parity. Run one gate with
`bun run <gate>`; `CHECK_ALL_VERBOSE=1` streams output, `--bail` stops at the first failure.
Ratchet budgets live in `scripts/*-budget*.json` (file size 500 lines, zero untracked
TODO/FIXME, coverage floors) and only tighten: split a large file instead of raising its
budget. CI (`.github/workflows/ci.yml`) runs each gate as its own step; `check:ci-parity`
fails if CI and the manifest drift apart.

Tests: colocated `*.test.ts`, real I/O in temp dirs, no mocks; spawn-based CLI smoke tests in
`src/cli-smoke.test.ts`. Human commands in tests use `ROOTS_FORCE_TTY=1` (honored only with
`NODE_ENV=test`). `fs.watch` tests must wait until the watcher is live (`armed()` in
`src/watch.test.ts`); never rely on a fixed sleep.

## Layout

```
src/index.ts        CLI entry + router (keep thin)
src/commands/       one file per subcommand
src/*.ts            store, ids, config, output, graph, etc.
  cli.ts            runCli(argv, io) → exit code (pure; tests run it in-process)
  register-all.ts   the one command registry
  workspace.ts      openWorkspace(): find .roots/, dir-rename fix-up, load graph
  store.ts          locks, atomic writes, JSONL dedup (last wins)
  resolve.ts        id | hex | slug | unique prefix → node
  actor.ts guard.ts human/agent actors, TTY guard
  test-helpers.ts   run()/runJson() in-process, spawnCli(), fakeTerminal(), waitFor()
  rules.ts          deterministic question rules (pure); thresholds in config `questions:`
  questions.ts      questions.jsonl: add/answer/dismiss/snooze/delegate/undelegate (one event each)
  delegation.ts     [a] in think: research run after the session; findingPreview() for the screen
  proposals.ts      proposals.jsonl: fileProposals() = expire+cite+reject+dedup+cap checks;
                    overdue or moot (endpoint composted/gone/closed sprout) pending ones expire
  mentions.ts       mention detection (pure); mention-scan.ts turns them into proposals
  attention.ts      "what needs thinking" ranking (think with no id, queue)
  session.ts        think session state machine (pure reducer)
  think-session.ts  session shell: watcher + keys + effects + finalize
  think-agent.ts    think's agent helpers: phase notice, summaries, proposal run; background mode (flow)
  think-screen.ts   left-pane TUI renderer (pure); terminal.ts raw mode; watch.ts; split.ts
  tier.ts           effectiveTier() (per-idea override, else config) + requireTier() guard
  context.ts        buildContext() packet + renderContextMarkdown() (roots context, agent stdin)
  agent-questions.ts askAgentQuestion(): every `roots ask` check (tier, cap, dedup, text)
  agent-runner.ts   runAgentCommand(): agent.command via sh, process group, timeout; AGENT_INSTRUCTION
  agent-phase.ts    think's pre-session agent step (off | harness | full | command)
  prime.ts          buildPrime()/renderPrimeMarkdown(): accepted graph + agent guide
  spinner.ts        startStatus(): one-line status while waiting on the agent
  next.ts           nextStep()/printNext(): the `next:` hint after human commands
  flow.ts           flow trail + card reducer (pure); flow-render.ts draws the card; flow-session.ts is the shell
  headings.ts       fileHeading() (tier, live flow, 2 sentences/280 chars, cites, dismissed) + dismissHeading()
  heading-run.ts    heading packet + runHeadingPhase(): agent.command with ROOTS_FLOW after each flow session
  editor-pane.ts    showInEditorPane(): reuse one tmux vim pane across flow sessions (`:update | edit`)
  graph-rules.ts    edge invariants (pure): checkEdge() for writes, graphViolations() for verify
  edges.ts          addEdge()/removeEdge() under the graph lock (replaces composts the target)
  lifecycle.ts      idea status transitions (transitionError, setIdeaStatus, statusEvent)
  agent-proposals.ts proposeAsAgent(): every `roots propose` check (tier, cites, invariants)
  decide.ts         accept/reject dispatcher by id prefix (p- here; s- in sprout-decide.ts)
  tend.ts           tend cards + key reducer (pure); tend-render.ts draws cards; tend-session.ts is the shell
  boundary.ts       agent writes only under .roots/agent/ (no traversal, symlinks, human/)
  node-create.ts    createNode(): hex + slug + prose file (plant, adopt, sprout)
  sprouts.ts        fileSprout() (tier, cap, dedup, TTL), lazy expiry, sproutView()
  adopt.ts          completeAdoption(): idea + `derives` edge + sprout adopted, one lock;
                    endorse: idea.md = human thoughts, node.endorses pins sprout.md's hash
  endorse.ts        readEndorsed()/endorsedMarkdown(): endorsed agent text, quoted + [agent] label
  sprout-decide.ts  s- decider: accept = adopt (needs ctx.adopt / TTY), reject (permanent)
  notes.ts          attachNote()/listNotes(): agent/notes/<hex>/YYYY-MM-DD-<slug>.<ext>
  serves-tree.ts    anchor → incoming-serves DFS with back-refs (shared by prime and view)
  view.ts           buildView() + renderViewMarkdown() (deterministic; ROOTS.md); view-html.ts --html page
  verify.ts         VERIFY_CHECKS (append to extend) + record/author/ref checks; verify-boundary.ts
                    dirs, human/ tree, hash ledger; verify-core.ts issue types + line-numbered JSONL scan
  git-trust.ts      gitProbe() + isAgentCommit() for the hash ledger
  hook-guard.ts     `roots guard` decisions (paths, symlinks, best-effort Bash)
  claude-settings.ts `setup claude` hook merge; desiredHooks() adds Stop/drift at tier 3 when `drift` exists
  blame.ts          lineHash() for answer events; buildBlame() lines → question (hashes, else
                    spanLines() replay when idea.md is unchanged since session end); answerBlocks() for view
  idea-refs.ts      citedIdeaIds(): exact `r-xxxx` tokens in free text (seeds, mulch, commits)
  seeds-link.ts     read-only .seeds/issues.jsonl: linkedIssues() (intent field, else r- mention), readyToMarkBuilt()
  mulch-link.ts     read-only .mulch/expertise/*.jsonl: learningsFor() (records citing an r- id)
  drift.ts          gatherDrift() (git, never throws) + matchDrift() (slug/prose/seeds/commit + serves ancestors)
.roots/             (in user projects) format: see README and src/types.ts
```

## Invariants (do not break)

1. **Human/agent separation.** No agent command (`ask`, `note`, `propose`, `sprout`, `heading`, `context`, `prime`) writes under `.roots/human/`. Human commands (`plant`, `think`, `flow`, `adopt`, `tend`) require a TTY.
2. **No LLM in the CLI.** An agent runs only through the user-configured `agent.command`.
3. **Human prose is untouched.** Roots never writes frontmatter, IDs or markers into `idea.md`. The statement is read from the file and is never cached in JSONL.
4. **Every agent write is validated.** Check tier, caps, TTL, exact-substring citations and permanent rejections, then fail with a clear error.
5. **Nothing auto-accepts.** Only humans create edges, change status or accept proposals.
6. `--json` on every command, same shape as seeds: `{success, command, ...}` / `{success:false, error}`.
7. `events.jsonl` is append-only. Every mutation logs one event with `by`.
8. JSONL is merge=union. Dedup on read, last occurrence wins.

## Agent Workflow

- Start: `ml prime`, `sd prime`, `sd ready`.
- Pick work from `sd ready`. Make the tier-0 `think` loop feel good before you add agent features.
- Track work in `sd`. Record learnings with `ml record <domain>`. Domains: `cli store graph think agent view`.
- Before you finish: `bun run verify`, `sd close <id>`, `ml sync`, then commit. Commit only when asked.

## Further reading

- `README.md`: user-facing overview and command reference
- `RUNBOOK.md`: gate failures, flaky tests, repairing `.roots/`
- `CONTRIBUTING.md`, `CHANGELOG.md`

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard:v0.10.7 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) v0.10.7 for structured expertise management.

**At the start of every session**, run:
```bash
ml prime
```

Injects project-specific conventions, patterns, decisions, failures, references, and guides into
your context. Run `ml prime --files src/foo.ts` before editing a file to load only records
relevant to that path (per-file framing, classification age, and confirmation scores included).

For monolith projects where dumping every record wastes context, set
`prime.default_mode: manifest` in `.mulch/mulch.config.yaml` (or pass `--manifest`) to emit a
quick reference + domain index. Agents then scope-load with `ml prime <domain>` or
`ml prime --files <path>`.

**Before completing your task**, record insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made:
```bash
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Evidence auto-populates from git (current commit + changed files). Link explicitly with
`--evidence-seeds <id>` / `--evidence-gh <id>` / `--evidence-linear <id>` / `--evidence-bead <id>`,
`--evidence-commit <sha>`, or `--relates-to <mx-id>`. Upserts of named records merge outcomes
instead of replacing them; validation failures print a copy-paste retry hint with missing fields
pre-filled.

Run `ml status` for domain health, `ml doctor` to check record integrity (add `--fix` to strip
broken file anchors), `ml --help` for the full command list. Write commands use file locking and
atomic writes, so multiple agents can record concurrently. Expertise survives `git worktree`
cleanup — `.mulch/` resolves to the main repo.

`ml prune` soft-archives stale records to `.mulch/archive/` instead of deleting them; pass
`--hard` for true deletion. Restore an archived record with `ml restore <id>`. Do not read
`.mulch/archive/` directly — those records are stale by definition. If you need historical
context, run `ml search --archived <query>`.

### Before You Finish

If you discovered conventions, patterns, decisions, or failures worth preserving during
this session, record them before closing:

```bash
ml learn                                                                    # see what files changed
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
ml sync                                                                     # validate, stage, commit
```

Skip if no insight surfaced. Unrecorded learnings are lost; ritual filler records are also noise.
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard:v0.5.12 -->
<!-- seeds-onboard-schema:7 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) v0.5.12 for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows. Pass `--format json|compact|markdown|plain|ids` on any command for agent-friendly output.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd search <query>` — Full-text search across titles + descriptions
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Planning
Use `sd plan` when work is large or ambiguous enough that an LLM benefits from structured decomposition. Submit spawns one child seed per step; `step.blocks` uses forward semantics (step i with `blocks: [j]` means step i blocks step j, and step j gets step i's id in its `blockedBy`).

- `sd plan templates` — List built-ins (`feature`, `bug`, `refactor`) plus custom templates
- `sd plan prompt <seed-id>` — Emit a structured prompt the LLM fills in
- `sd plan submit <seed-id> --plan <file>` — Validate + spawn child seeds
- `sd plan show <pl-id>` — View sections, children, sub-plans
- `sd plan edit <id> [--name | --section <name> <text> | --step <i> --title/--priority/--type]` — In-place field edits; bumps revision
- `sd plan outcome <pl-id> --result success|partial|failure` — Record outcome (storage-only)
- `sd plan review <pl-id> --by <name>` — Record reviewer (informational)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->
