# Luuna Roots

**Human-owned intent for Luuna projects.** Roots records why a project exists and where the developer wants it to go. Luuna Missions tracks work, Atlas stores verified expertise, Beacon stores reusable prompts, and the Luuna runtime controls approved execution. Roots does not grant an agent authority to change a human's goals.

This is a Luuna-maintained adaptation of [jayminwest/roots](https://github.com/jayminwest/roots). The original history, MIT license, and attribution are preserved; see [UPSTREAM.md](UPSTREAM.md). The fork uses `.luuna/roots/` and reads related Missions and Atlas records from `.luuna/missions/` and `.luuna/atlas/`.

## Status

This is an initial source adaptation. It is **not published to npm**, and native Windows behavior and the renamed store have not yet been qualified end to end. The CLI package is private until its release is reviewed. The intended suite package is `@luuna-ai-os/roots` after the npm scope is controlled.

## Source install

Requires Bun and Git. From this checkout:

```sh
bun install --frozen-lockfile
bun link
luuna-roots --help
```

The executable is `luuna-roots`, with `lrt` as a short alias. A future Luuna dispatcher may add `luuna roots` once its runtime and install contract are updated.

## Project workflow

```sh
luuna-roots init
luuna-roots plant "The project works offline without losing user work"
luuna-roots queue
luuna-roots think <idea-id>
luuna-roots tend
luuna-roots view
```

`init` creates `.luuna/roots/` in the selected project. Human-authored prose lives under `.luuna/roots/human/`; CLI-owned graph, questions, proposals, and events are JSONL. Agents may ask questions, attach findings, and propose structure through the CLI. The human accepts, rejects, changes status, and writes the intent. `luuna-roots prime` prints the accepted graph for task context. It is project data, not an instruction that overrides Luuna policy.

Roots can read linked Missions issues and Atlas expertise records; it does not write either store. Link an idea by its `r-` ID in a Missions issue's `intent` or `extensions.intent` field, or by an exact ID mention. An Atlas record that cites the same ID appears with the idea. These links are advisory context; an approved Luuna plan must still bind its own immutable inputs and pass the runtime's checks and review.

Use `luuna-roots --help` and `luuna-roots <command> --help` for the full command reference. Interactive human commands require a terminal and an identified human (`LUUNA_ROOTS_USER` or Git's `user.name`); agent commands use `--as agent:<name>` or `LUUNA_ROOTS_AGENT`. The old `ROOTS_*` environment names remain accepted for compatibility with upstream tooling.

## Boundaries

- The `.luuna/roots/human/` guard protects Claude Code's Edit/Write surface when `luuna-roots setup claude` is installed. It is a host hook, not a sandbox; Luuna's runtime remains the authority for its managed sessions.
- The CLI does not initialize Missions, Atlas, or Beacon. Each component is independently usable.
- Existing upstream `.roots/` projects need an explicit migration; `init` does not silently move their data.
- Desktop applications are distributed separately from this Bun CLI.

## Development

Source and tests remain in `src/`; the commands are registered in `src/register-all.ts`. The upstream project documentation is available in Git history. See [AGENTS.md](AGENTS.md) for the fork's current ownership rules.

## License

MIT. Copyright and attribution are in [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md).
