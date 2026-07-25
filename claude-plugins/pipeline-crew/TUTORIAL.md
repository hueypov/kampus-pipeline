# Tutorial — stand up your first crew

> **Diátaxis mode: tutorial** (learning-oriented). One mode per doc — a linear, hand-held
> lesson to a guaranteed outcome. Look up an exact contract (frontmatter, roster, config keys)
> in the [reference](REFERENCE.md); fill the per-install seam with the
> [personalization guide](PERSONALIZATION.md); understand *why* the crew is shaped this way in
> the [explanation](EXPLANATION.md).

By the end of this lesson you will have taken a repo from **zero crew** to a **live crew
draining the board**: the four roles installed, one operator config filled, `/stand-up` run,
and a triaged issue picked off the board by an engine — a PR opened without you touching a
terminal relay. That is the whole plugin in miniature: the shipped doctrine boots, the seam
carries your one config, and the flat topology takes over.

This is the **plugin** tutorial — standing up the crew as a standing operation. The channel
substrate it runs on has its own separate learning path; this lesson never reaches into it,
so you can follow it end to end from here.

## What you need

- The adopting repository checked out with its dependencies installed (run its documented
  dependency-install command at the repository root).
  The channel substrate `@kampus/pipeline-crew-mcp` is a **runtime prerequisite** — it ships in
  the repo and is available on `main` HEAD, so an installed repo already has it.
- **tmux** — `/stand-up` places each launched session into a `crew` tmux window; the crew runs
  as a set of live panes you can attach to and watch.
- A backlog to drain — at least one **open, `status:triaged`, unassigned** issue on the board.
  If you have none, that is fine: you will still watch the crew come up idle and pull the first
  triaged issue the moment one lands.

Nothing else is hand-run. Every mechanical step below is a single command; the crew does the work.

## The mental model, in three lines

- **The crew is four roles on a flat topology.** Three *bridges* (cartographer, intake-desk,
  chief-of-staff) each own one seam to the outside; an *engine* pool (engineering-manager ×N) is
  fungible throughput that pulls the board. No role routes work for another — the **board** is the
  durable source of truth (the [README](README.md) draws the topology).
- **One config, filled once, is the whole personalization.** The shipped plugin carries **zero**
  operator data; you copy a placeholder template to an operator-owned config and fill it. Every
  session resolves that one file at spawn.
- **`/stand-up` boots the self-driving roster.** It brings up the tracker + the two self-driving
  bridges (intake-desk, chief-of-staff) + N engines, and deliberately **excludes** the
  human-in-the-loop cartographer — you spawn that one on demand. Then the crew drains the board
  on its own.

## Step 1 — initialize the private toolkit

Add the one private toolkit submodule. It contains both the crew and companion
pipeline payloads:

```bash
git submodule add git@github.com:hueypov/kampus-pipeline.git .pipeline/toolkit
./.pipeline/toolkit/bin/pipeline init
```

Initialization gives the repository the four crew agent definitions, crew
commands, the companion pipeline skills, and the placeholder configuration
template. From now on, use `pnpm pipeline …` rather than a marketplace command.

## Step 2 — fill your operator config

The shipped template holds only `<placeholders>`. Copy it to an operator-owned config and fill
**every** placeholder — this is the one place your people, machine, and model tiers enter:

```bash
# Copy the placeholder-only template to the default config path.
cp .claude/crew.config.template.jsonc .claude/crew.config.jsonc
# Git-ignore your copy — it holds your operator data and must never be committed.
echo ".claude/crew.config.jsonc" >> .gitignore
```

Now open `.claude/crew.config.jsonc` and fill each `<...>`. The keys you must set to reach a
live crew:

- **`operator`** — the human the crew serves (`name`, `handle`).
- **`controlPlaneApprover`** — who approves/merges control-plane (§CP) PRs; the engine banks §CP
  work on the board and the chief-of-staff relays it to this identity.
- **`roles`** — one model tier per bridge, plus the engine pool's `tier`, `count` (how many
  engines boot), and `wipCap` (the per-engine concurrent-lane caps). A three-engine crew that
  drains steadily is a fine first `count`.
- **`notification`** — the transport `command` the chief-of-staff invokes to ping the operator
  and the §CP approver. Any local script path lives **only** here, never in the repo.
- **`channels`** — how each launched session registers the crew channel MCP (the `mode` and the
  server `servers`/`allowedChannelPlugins` refs).

Leave **no** `<...>` behind — the [reference](REFERENCE.md) and
[personalization guide](PERSONALIZATION.md) carry the full key-by-key contract if a placeholder
is unclear. A def that can't resolve a filled config **stops and asks you to run stand-up**;
there is no baked-in default human, so an unfilled config is caught, not guessed.

> The config is resolved by the same order every seam key uses: **`$CREW_CONFIG`** if set,
> otherwise the working repo's **`.claude/crew.config.jsonc`**. Set `$CREW_CONFIG` only if you
> keep the file somewhere other than the default path.

## Step 3 — stand the crew up

One command boots the whole self-driving roster:

```
/stand-up
```

It runs, in order: assert the CLI version → ensure the per-project tracker is up → derive the
roster session set (one per self-driving bridge + N engines) → build each session's channel bind
+ tmux placement → launch each `claude` session bound to its role lease. It is **fail-loud with
no partial crew**: a missing config dimension, an unstartable tracker, an inert channel, or a
failed placement aborts **before any session launches** and names the cause. If it aborts, fix
the one named precondition and re-run — never hand-launch a session to "finish" a partial crew.

On success it reports the **tracker pid + socket** and the **launched sessions**. That report is
your first checkpoint: the crew process is up.

> `/stand-up` deliberately **excludes** the human-in-the-loop cartographer
> (the topology rule: each unique-seam bridge is a singleton, while seam-free engines may scale and bridges never execute engine lanes, the on-demand cartographer rule) — it boots only
> the self-driving roster (intake-desk, chief-of-staff, and the engines). You bring the
> cartographer up **on demand** with [`/spawn-role cartographer`](commands/spawn-role.md) when
> you want to chart founder fog; it boots idle, waiting for you. You do not need it to drain the
> board, so skip it for this lesson.

## Step 4 — watch the crew come alive

The launched sessions live in a `crew` tmux window. Attach and look:

```bash
tmux attach -t crew      # or: tmux select-window -t crew  if already attached
```

You will see one pane per role — the two bridges and your N engines, each a live `claude`
session bound to its role on the channel. This is the crew *at rest*: up, connected, and
watching the board. Nothing is hand-driven; the panes coordinate over the channel and read the
board for truth.

## Step 5 — watch the board drain (the guaranteed outcome)

With the crew live, the flat topology takes over. Put one **open, `status:triaged`, unassigned**
issue on the board (or point at one you already have), then watch an **engine** pick it up:

- The engine pulls the highest-priority ready issue off the board and **claims** it — it
  self-assigns the issue and posts a `claim:` comment stamped with its session id (the
  agent-distinguishable claim,
  the ownership rule: session-stamped claims give only the earliest authorized claimant permission to mutate work). You can see this on
  the issue itself:

  ```bash
  gh issue view <N> --json assignees,comments \
    --jq '{assignee: .assignees[].login, claim: (.comments[] | select(.body|test("^claim:")) | .body)}'
  ```

- The engine then drives the pipeline — coder → reviewer → shipper — under its WIP cap, and a
  **PR opens** that closes the issue (`Fixes #N`). A non-§CP PR auto-ships on green; a §CP PR
  banks on the board for the human approver, and the chief-of-staff relays it out.

That is the verifiable end state: **an idle issue on the board became a claimed, in-flight lane
with an open PR — with no terminal relay from you.** The crew is live and draining. Every new
`status:triaged` issue now flows the same way; refill the board and the engines keep pulling
under their caps.

## What you just did

You took a repo from zero crew to a standing operation:

| Move | Command | What it established |
|---|---|---|
| Initialize | `pipeline init` | the four agent defs + the two commands + the config template |
| Personalize | `cp … crew.config.jsonc` + fill | your one operator config — the whole per-install seam |
| Stand up | `/stand-up` | the tracker + self-driving bridges + N engines, live and channel-bound |
| Scale / HITL | [`/spawn-role <role>`](commands/spawn-role.md) | one on-demand role (the cartographer, or an extra engine) into the running crew |

The crew is now self-driving: the board is the source of truth, the channel is a latency
optimization over it, and the silences between roles are the design (the [README](README.md)
draws the sparse comms graph). You never route work between roles — a triaged issue becomes
pickable and an engine pulls it.

## Where to go next

- **Scale or add the cartographer** — bring up one more engine, or the human-in-the-loop
  cartographer for a `wayfinder chart`: [`/spawn-role <role>`](commands/spawn-role.md).
- **Look up a contract** — the agent-def frontmatter, the full roster (bridges vs engine), every
  `crew.config.jsonc` key, and the notification transports: the [reference](REFERENCE.md).
- **Tune the seam** — the full dimension table and the stand-up contract the defs write against:
  the [personalization guide](PERSONALIZATION.md).
- **Understand why** — the roster law, the §CP hard gate, verify-don't-relay, and single-owner
  human comms: the [explanation](EXPLANATION.md).

## Grounding

- The stand-up command: [`commands/stand-up.md`](commands/stand-up.md).
- The on-demand launch: [`commands/spawn-role.md`](commands/spawn-role.md).
- The config template you fill: [`crew.config.template.jsonc`](crew.config.template.jsonc).
- The four agent defs: [`agents/`](agents/) — cartographer, intake-desk, engineering-manager,
  chief-of-staff.
- The topology + comms graph: [`README.md`](README.md).
