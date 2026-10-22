# Contributing to Roots

Thanks for your interest in contributing to Roots. This guide covers what you need to get started.

Direction lives in Missions issues and roots ideas; there is no spec doc. If a change conflicts with
recorded intent, raise it in the issue or PR. Do not quietly pick one.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/roots.git
   cd roots
   ```
3. **Install** dev dependencies. This also points git at `scripts/hooks` (pre-commit runs lint and
   typecheck):
   ```bash
   bun install
   ```
4. **Create a branch**:
   ```bash
   git checkout -b fix/description-of-change
   ```

## Branch Naming

- `fix/` -- bug fixes
- `feat/` -- new features
- `docs/` -- documentation changes
- `refactor/` -- code refactoring
- `test/` -- test additions or fixes

## Build & Test Commands

```bash
bun run verify        # the full gate suite (= bun run check:all); CI runs the same gates
bun test              # tests only; one file: bun test src/foo.test.ts
bun run lint:fix      # Biome format + safe fixes
```

`bun run verify` must pass before you open a PR. It runs lint, typecheck, AGENTS.md accuracy,
duplication, unused dependencies, the file-size and debt-marker ratchets, tests with coverage
floors, and CI parity. Budgets in `scripts/*.json` only tighten: split a large file instead of
raising its budget.

## Coding Conventions

- **Zero runtime dependencies.** Dev dependencies only. Arg parsing and ANSI color are hand-rolled.
- Tabs, 100-column lines, kebab-case file names (enforced by Biome).
- Strict TypeScript with `noUncheckedIndexedAccess`. No `any`, no non-null assertions.
- Cognitive complexity of at most 15 per function. Split functions rather than suppress the rule.
- One file per subcommand in `src/commands/`, registered in `src/register-all.ts`.
- Keep the invariants in [AGENTS.md](AGENTS.md): agent commands never write under
  `.luuna/roots/human/`, human commands need a TTY, every mutation logs one event, nothing
  auto-accepts.

## Testing

- `bun test`, colocated as `src/foo.test.ts` next to `src/foo.ts`.
- Real I/O in temp directories. No mocks.
- Add a CLI smoke test for every new command.
- Tests that depend on `fs.watch` must wait until the watcher is live (see `armed()` in
  `src/watch.test.ts`). A fixed sleep is not enough on a loaded macOS machine.

## Pull Request Expectations

- **One concern per PR.**
- **Tests required** for new features and bug fixes.
- **Passing CI.**
- **Description.** Say what and why. Link the issue.

## Reporting Issues

Use [GitHub Issues](https://github.com/jayminwest/roots/issues) for bug reports and feature
requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
