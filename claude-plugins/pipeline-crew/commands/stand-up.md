---
description: Stand the whole pipeline crew up from the operator config — tracker + all bridge sessions + N engine sessions, each launched bound to its role lease, fail-loud with no partial crew.
argument-hint: "[--project-root <path>] [--terminal <tmux|herdr>]"
allowed-tools: ["Bash"]
---

# Stand up the crew

This is the **one stand-up command**: it boots the entire crew from your filled operator
config in one shot. It is a thin front for the substrate launcher — the mechanical logic
(version assert, tracker ensure, roster derivation, per-session bind, screen placement,
launch) lives in the `pipeline-crew-mcp` substrate's `stand-up` subcommand
(the launcher rule: commands stay thin and delegate launcher mechanics to the tested crew service), never in this plugin.

## Preconditions

You must have a **filled** operator config before standing up — the plugin ships only a
placeholder template. If you have not done this yet, follow the
[PERSONALIZATION.md](../PERSONALIZATION.md) stand-up steps first:

`pipeline init` creates the placeholder-only, git-ignored file at
`.claude/crew.config.jsonc`. Fill every `<placeholder>` there before standing the Crew up.

The launcher resolves the config by the same order as every seam key: `$CREW_CONFIG` if
set, otherwise the working repo's `.claude/crew.config.jsonc`.

## Run it

Invoke the substrate's `stand-up` subcommand (pass through `$ARGUMENTS`, e.g.
`--project-root <path>`; it defaults to the current working directory):

```bash
"$CLAUDE_PROJECT_DIR/.pipeline/toolkit/bin/pipeline" crew stand-up $ARGUMENTS
```

### Which terminal the panes land in

The crew is placed in the terminal the operator config's `terminal` dimension names — `tmux` (the
default) or `herdr` — and `--terminal <tmux|herdr>` overrides it for one invocation. A multiplexer is
only a **window manager** here, so this changes where panes land and nothing else: same roster, same
binds, same fail-closed launch. Either way the whole crew lands in ONE container, a pane per role, so
every member stays visible at once — a tiled `crew` window under tmux, a `pipeline` tab under herdr.
Selecting `herdr` requires its binary on `PATH`; an absent binary aborts the stand-up naming it.

The launcher runs, **in order**: assert the pinned CLI version → ensure the per-project
tracker is up → derive the roster session set (one per bridge + N engines) → build each
session's channel bind + screen placement → launch each `claude` session bound to its role
lease. It is **fail-loud with no partial crew**: a drifted CLI pin, a missing config
dimension, an unstartable tracker, an inert channel, or a failed screen placement
aborts **before any session is launched** and names the cause. Nothing is hand-launched.

Report the tracker pid + socket and the launched sessions on success, or the named abort
cause on failure. Do not hand-launch any session to "finish" a partial stand-up — re-run
this command once the named precondition is fixed.
