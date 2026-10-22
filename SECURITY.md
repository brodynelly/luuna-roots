# Security Policy

## Supported Versions

Roots is pre-release (0.x). Only the latest commit on `main` receives security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/jayminwest/roots/security/advisories):

1. Go to the [Security Advisories page](https://github.com/jayminwest/roots/security/advisories).
2. Click **"New draft security advisory"**.
3. Describe the vulnerability, with steps to reproduce if possible.

### Response Timeline

- **Acknowledgment**: within 48 hours of your report
- **Initial assessment**: within 7 days
- **Fix or mitigation**: within 30 days for confirmed vulnerabilities

## Scope

Roots is a local CLI that reads and writes files under `.luuna/roots/` and runs one user-configured
agent command. These are security issues:

- **Command injection** -- unsanitized input reaching a shell (`agent.command` runs through
  `sh` by design; injection through idea text, slugs or flags is a bug)
- **Path traversal** -- agent commands (`note`, `sprout`) writing outside `.luuna/roots/agent/`
- **Boundary bypass** -- any agent-facing command that writes under `.luuna/roots/human/`, or any way to
  make `luuna-roots guard` allow an agent edit there
- **Symlink attacks** -- following symlinks out of `.luuna/roots/`
- **Temp file races** -- TOCTOU in lock or atomic-write handling

Not in scope:

- A deliberately malicious actor with shell access. The human/agent boundary defends against
  accidental mixing, not against an attacker.
- Denial of service through large input files.
- Behavior of the agent that `agent.command` runs.

## Security Measures

- Atomic writes (temp file + rename) and advisory file locks with stale-lock detection
- Agent writes confined to `.luuna/roots/agent/` (no traversal, no symlinks, no `human/`)
- `luuna-roots guard` PreToolUse hook denies harness edits to `.luuna/roots/human/**`
- Hash ledger: `luuna-roots verify` reports human files changed outside a recorded session or a
  human-authored commit
- Zero runtime dependencies
