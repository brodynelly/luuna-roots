# Roots

Git-native intent for projects. Humans write ideas. Agents ask questions and propose structure.
Agents never write human intent.

[![CI](https://github.com/jayminwest/roots/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/roots/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Part of the os-eco toolchain: [seeds](https://github.com/jayminwest/seeds) tracks *what to do*,
[mulch](https://github.com/jayminwest/mulch) records *what we learned*, roots holds *why, and
toward what*.

Project vision usually lives in your head (agents cannot see it) or in large agent-written
planning docs (after two sessions nobody knows what the human wanted and what the model
invented). Roots makes intent cheap to add, one sentence and a few questions at a time, and keeps
provenance explicit: every idea, edge and question has one author, and human and agent content
never mix.

- **Plain prose.** Each idea is a plain `idea.md`: no frontmatter, no IDs, no link syntax.
  All structure lives in CLI-owned JSONL.
- **No LLM inside.** `roots` is deterministic. Agents are clients that call the CLI, and every
  agent write is checked (tier, caps, TTL, exact-quote citations, permanent rejections).
- **Nothing auto-accepts.** Only a human creates edges, changes status or accepts a proposal.
- **Zero runtime dependencies.** Bun + TypeScript, JSONL + advisory locks, `--json` everywhere.

## Install

Roots is pre-release and not yet published to npm. Install from source (needs
[Bun](https://bun.sh) ≥ 1.0):

```bash
git clone https://github.com/jayminwest/roots
cd roots
bun install
bun link              # makes `roots` available globally
roots --version
```

## Quick Start

A walkthrough of the core loop: **plant → think → tend → view**. Human commands (`plant`,
`think`, `flow`, `adopt`, `tend`) need an interactive terminal, and every human command needs a name
(`ROOTS_USER`, else `git config user.name`).

```bash
cd your-project
roots init                     # creates .roots/ and adds `.roots/*.jsonl merge=union` to .gitattributes

# 1. Plant: one sentence of intent (no argument opens $EDITOR)
roots plant "Sync works fully offline, and nobody loses work when the network drops"
# ✓ planted r-a228 sync-works-fully-offline
#   .roots/human/a228-sync-works-fully-offline/idea.md
roots plant "The server is always authoritative"
roots mv sync-works-fully-offline offline-sync     # slugs are yours; the id never changes

# 2. Think: one question at a time about one idea
roots queue                    # what needs thinking, open questions, pending proposals
roots think offline-sync       # opens idea.md in $EDITOR (a split inside tmux/zellij)
```

In a think session, the left pane shows the idea, its edges and the current question. Write in
`idea.md` and save: a save that changes the file answers the question and moves on. Nothing is
ever inserted into your file. Keys: `[d]` dismiss (never ask again), `[z]` snooze, `[s]` skip,
`[q]` end. Questions come from deterministic rules ("What would make this done?", "What is this
*not* trying to solve?", "Is this one idea or two?") and, at tier ≥ 1, from your agent.

Would rather have the agent look something up? `[a]` hands the question to the agent. After the
session it researches the question and attaches findings (`roots note --question`). The question
comes back next time with the findings' first paragraph under it. You still answer in `idea.md`:
the agent informs, you decide. A question the agent could not answer comes back as it was.

```bash
# 3. Tend: review what agents and mention detection proposed, one keystroke per card
roots tend
# ┌ proposal p-0485 ── [agent] claude-opus-5-5 ── expires in 14d ─┐
# │ offline-sync  ↔ tension ↔  server-authoritative                │
# │   r-a228: "nobody loses work"                                  │
# │   r-97d5: "always authoritative"                               │
# │ [y] accept  [n] reject  [r] reject w/ reason  [s] skip         │
# └────────────────────────────────────────────────────────────────┘

roots link offline-sync field-teams-trust-app serves   # or add an edge yourself
roots commit field-teams-trust-app                     # after it has been shaped in `think`

# 4. View: one readable document from your prose and accepted structure
roots view                     # Markdown to stdout: anchors, what serves them, tensions, questions
roots view --html --out intent.html
```

Or do all of it in one sitting:

```bash
roots flow                     # think → card → next idea, without dropping to the shell
```

Between sessions `flow` shows a card with the trail (what you touched this flow), an `[agent]`
heading on where your thinking is going (cited, dismissable with `[x]`, never shown in views),
agent work still running, the inbox, and the next idea. `[enter]` does the obvious next step.
Agent questions arrive while you write; links and the heading are worked out in the background.
Under tmux with vim/nvim, one editor pane follows you from idea to idea.

Every human command ends with a `next:` line naming the step that is most worth doing.

Commit `.roots/` with your code. Roots never runs git for you.

## Concepts

| Term | Meaning |
|------|---------|
| **Idea** (`r-xxxx`) | One human claim, stated in one sentence (the first line of `idea.md`). |
| **Sprout** (`s-xxxx`) | An idea proposed by an agent. Lives only in `.roots/agent/`. A human can `adopt` it by rewriting it in their own words, or endorse it (`adopt --endorse`, `[t]` in `tend`): the sprout stays the agent's text, pinned by hash and quoted with an `[agent]` label, and the human writes only their thoughts on it. |
| **Edge** | `serves`, `tension`, `replaces` (composts the target) or `derives` (idea from sprout). Only humans create edges. |
| **Proposal** (`p-xxxx`) | A pending agent suggestion: `edge`, `split`, `merge` or `compost`. Must quote the human's words. Capped, and expires after `limits.proposalTtlDays`. |
| **Question** (`q-xxxx`) | A prompt about one idea, from a rule or an agent. |

Idea lifecycle: `planted → shaping → committed → built`, and any status → `composted`.
`shaping` is set by the first think session; everything else is a human command.

Pending proposals that become moot (an idea they name is composted, or a sprout they name is no
longer open) drop out of `queue`, `tend` and `show` at once, and are marked `expired` (event
reason `moot: …`) the next time `tend`, `accept`, `reject` or proposal filing runs.

## Commands

Every command supports `--json` (`{success, command, ...}` or `{success: false, command,
error}`), `-h`/`--help` and `-q`/`--quiet`. `roots --version` prints the version. Colors respect
`NO_COLOR` and non-TTY output. Ideas resolve by `r-a1b2`, `a1b2`, slug or unique prefix.

### Setup

| Command | Description |
|---------|-------------|
| `roots init` | Initialize `.roots/` in the current directory |
| `roots setup claude [--project\|--user] [--remove] [--dry-run]` | Install Claude Code hooks (see below) |
| `roots guard` | PreToolUse hook: deny agent edits to `.roots/human/` (reads hook JSON on stdin) |

### Capture and think (human, TTY)

| Command | Description |
|---------|-------------|
| `roots plant [<statement>]` | Create an idea. With no argument, opens `$EDITOR` |
| `roots think [<id>] [--no-split]` | Run a think session. With no id, picks from the queue |
| `roots flow [<id>] [--no-split]` | Think, review and plant in one session; the agent works in the background |
| `roots adopt <sprout-id> [--endorse]` | Create an idea from a sprout: you write it in `$EDITOR` (the sprout is quoted below a scissors line, removed on save); a `derives` edge keeps the lineage. `--endorse`: accept the sprout as written and write only your thoughts |
| `roots mv <id> <new-slug>` | Rename an idea or sprout (the id is stable) |

### Structure (human)

| Command | Description |
|---------|-------------|
| `roots tend` | Interactive review: proposals and sprouts, soonest expiry first (TTY). On a sprout, `[t]` accepts it with thoughts typed under the card (ctrl-e continues in `$EDITOR`) |
| `roots accept <p-id\|s-id>` | Accept a proposal (`--rel` for mention edges, `--keep` for merges); `s-` adopts a sprout |
| `roots reject <p-id\|s-id> [--reason <t>]` | Reject; remembered permanently |
| `roots link <a> <b> <rel>` | Add an edge directly |
| `roots unlink <edge-id>` | Remove an edge |
| `roots scan [<id>]` | File link proposals for mentions in edits made outside a session |
| `roots commit <id>` | Set status to `committed` |
| `roots status <id> <status>` | Change an idea's status |
| `roots compost <id> [--reason <t>]` | Retire an idea |
| `roots tier <id> [<0-3>\|default]` | Per-idea agent tier override |

### Agent-facing (agent)

Agents identify with `--as agent:<model>` or `ROOTS_AGENT`. These commands never write under
`.roots/human/`.

| Command | Tier | Description |
|---------|------|-------------|
| `roots context <id>` | any | Context packet for one idea: prose, neighbors, prior and dismissed questions, rejections |
| `roots prime [--scope <id>]` | any | Accepted graph as agent context (anchors → committed ideas) plus a command guide |
| `roots drift [--diff <rev>]` | 3 | Ideas a repo change touches (the Stop hook; never blocks) |
| `roots ask <id> <question>` | ≥ 1 | Queue a question about an idea |
| `roots note <id> --file <path> [--question <q-id>]` | ≥ 1 | Attach an artifact under `.roots/agent/notes/`; with `--question`, findings on a question you delegated with `[a]` |
| `roots propose edge <a> <b> <rel> --reason <t> --cite <id>:<quote> ...` | ≥ 2 | Propose an edge; quotes must be exact substrings of each idea |
| `roots propose split\|merge\|compost ...` | ≥ 2 | Propose restructuring an idea |
| `roots sprout <statement> [--file <md>]` | ≥ 2 | Propose a new idea in the agent tree |
| `roots heading <text> --cite <id>:<quote> ... [--next <id>]` | ≥ 1 | During `roots flow` (`$ROOTS_FLOW`): where the session is going; ≤ 2 sentences, 280 chars |

### Read (anyone)

| Command | Description |
|---------|-------------|
| `roots show <id>` | An idea or sprout with edges, questions, proposals, seeds issues, mulch learnings, history |
| `roots list [--status <s>] [--kind idea\|sprout] [--orphans] [--anchors]` | List ideas and sprouts |
| `roots queue` | What needs attention: think next, open questions, pending proposals, sprouts, ideas ready to mark `built` |
| `roots blame <id>` | `idea.md` with the id of the question each line answered in the margin (matched by line content, so later edits elsewhere do not break it) |
| `roots log [<id>]` | Event history (all, or for one node) |
| `roots view [--from <id>] [--sprouts] [--html] [--out <file>]` | Compiled culmination; only human prose and accepted structure. Answered paragraphs are labeled with their question |
| `roots verify` | Check the human/agent boundary, graph invariants and the hash ledger |

## Agent Tiers

Tiers only widen what an agent may *suggest*. At no tier can an agent write to `human/`, change
status, accept a proposal or create an edge. `roots init` starts at tier 2.

| Tier | Name | Agent may |
|------|------|-----------|
| 0 | off | nothing; only deterministic questions |
| 1 | ask | `ask`, `note` |
| 2 | propose | tier 1 + `propose`, `sprout` |
| 3 | observe | tier 2 + run from harness hooks on repo activity (`drift`) |

Set the project tier in `.roots/config.yaml` (`tier:`). Keep an agent out of one idea with
`roots tier <id> 0`.

## Configuration

`.roots/config.yaml` (written by `roots init`):

```yaml
tier: 2                    # 0 off, 1 ask, 2 propose, 3 observe
agent:
  # command: "claude -p --model claude-opus-5-5"   # used by `think` to get questions
  timeoutSeconds: 120      # think continues without agent questions after this
limits:
  proposals: 10            # max pending proposals
  sprouts: 5               # max open sprouts
  questionsPerSession: 3
  proposalTtlDays: 14
  sproutTtlDays: 30
view:
  write: false             # true: `roots view` also writes ROOTS.md
flow:
  heading: true            # `roots flow`: the agent says where the session is going
```

With `agent.command` set, `roots think` runs it (through `sh`) with the idea's context packet on
stdin before the session and shows the questions it files with `roots ask`. Without it, a harness
already running in another pane can call `roots ask` itself. In `roots flow` the same command
runs in the background, and again after each session with `ROOTS_FLOW` set to file a heading.

## Claude Code Setup

```bash
roots setup claude            # writes .claude/settings.json in this project (--user for ~/.claude)
roots setup claude --dry-run  # print the merged settings without writing
```

This installs:

- a **SessionStart** hook, `roots prime --hook`, so each session starts with the accepted graph
  and a command guide;
- a **PreToolUse** hook, `roots guard`, that denies Write/Edit (and best-effort Bash) on
  `.roots/human/**`;
- at project tier 3, a **Stop** hook, `roots drift --diff HEAD`, that lists the ideas your change touches so
  the agent can `roots ask` whether they still hold. It never blocks.

Other harnesses use the same CLI; only the hook wiring differs. `roots setup claude --remove`
takes the hooks out again.

## Seeds and Mulch

- `sd create --intent r-a1b2` links a seeds issue to an idea. `roots show` lists linked issues,
  and `roots queue` suggests marking the idea `built` when all of them are closed.
- Mulch records that cite an `r-` id appear under that idea in `roots show`.

Roots only reads `.seeds/` and `.mulch/`.

## On Disk

```
.roots/
  config.yaml
  graph.jsonl        # nodes + accepted edges (CLI-owned)
  proposals.jsonl    # agent proposals (capped, expiring)
  questions.jsonl
  events.jsonl       # append-only log of every mutation, each with `by`
  headings.jsonl     # agent headings for `roots flow` (advisory, card only)
  human/<hex>-<slug>/idea.md       # your prose, nothing else
  agent/sprouts/<hex>-<slug>/sprout.md
  agent/notes/<hex>/...
```

JSONL files merge with `merge=union`; reads dedupe with the last occurrence winning.

## Development

```bash
bun install           # dev deps; also installs the pre-commit hook (lint + typecheck)
bun run verify        # full gate suite (= bun run check:all), same as CI
bun test              # tests only
bun src/index.ts ...  # run the CLI from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
