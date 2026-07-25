# kampus-pipeline — project scope and architecture

## What this project is building

`kampus-pipeline` is a **private, project-local agent-workflow toolkit**. It is
not an npm product, global command, or globally installed Claude marketplace
plugin. An adopting repository pins a particular toolkit revision as a Git
submodule, initializes local wiring once, and runs everything from that pinned
checkout.

The intended outcome is that a repository can use a consistent set of agent
workflows and an optional coordinated crew without taking a dependency on the
Phoenix repository, its deployment stack, or an npm publication.

```text
adopting Git repository
│
├── .pipeline/toolkit/             pinned Git submodule: this repository
├── .pipeline/pipeline.json        generated managed-file manifest
└── .claude/
    ├── settings.json              existing settings plus pipeline-owned hooks
    ├── skills/                    links to toolkit skills
    ├── agents/                    links to toolkit and crew agents
    ├── commands/                  links to crew commands
    ├── crew.config.template.jsonc generated placeholder template
    └── crew.config.jsonc          operator-owned filled copy (ignored)
```

The command that owns this setup is:

```bash
./.pipeline/toolkit/bin/pipeline init
```

## Design rules

- **Private distribution only.** Every workspace package is marked `private`.
  The supported distribution mechanism is a private Git repository and a
  submodule pointer committed by each consumer.
- **Project-local execution.** Hooks, Claude commands, and crew commands invoke
  `.pipeline/toolkit/bin/pipeline`; they do not resolve `pipeline-cli` or
  `pipeline-crew-mcp` from npm.
- **Pinned upgrades.** A consumer updates the submodule commit deliberately,
  commits that pointer, and runs `pipeline sync`. Nothing silently updates from
  a remote registry or branch.
- **Preserve consumer ownership.** Initialization merges pipeline-owned hooks
  into existing `.claude/settings.json`, records managed links in
  `.pipeline/pipeline.json`, and refuses to overwrite unknown files. `--force`
  is limited to paths already recorded as managed.
- **Keep operator data local.** The crew template contains placeholders only.
  The filled `.claude/crew.config.jsonc` and `.claude/crew-run/` are ignored.
- **No implied global install.** The project-local submodule flow in this file
  is authoritative for this repository, even where copied source documents
  mention an older marketplace-based installation path.

## Repository layout

| Path | Responsibility |
|---|---|
| `bin/pipeline` | Shell entry point that starts the bootstrap package with Node. |
| `packages/pipeline` | Private bootstrap: discovers the consumer repository, validates the submodule, installs/builds the toolkit workspace, generates Claude wiring, and forwards CLI/crew requests. |
| `packages/pipeline-cli` | Private TypeScript command router and its implementation/test suite for pipeline automation and guard tools. |
| `packages/pipeline-crew-mcp` | Private TypeScript crew substrate: tracker, peer/channel protocol, MCP edge, validated configuration, tmux launcher, and role lifecycle. |
| `claude-plugins/kampus-pipeline` | The issue-pipeline plugin: skills, agents, hooks, helper scripts, and its source documentation. |
| `claude-plugins/pipeline-crew` | The crew plugin: role definitions, user commands, configuration template, and operator documentation. |
| `templates/github/workflows` | Optional, project-agnostic GitHub Actions workflow pack installed only on request. |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml` | The only workspace dependency definition and reproducibility lock for the private toolkit. |

## Consumer workflow

### 1. Pin the toolkit

In the adopting repository:

```bash
git submodule add git@github.com:hueypov/kampus-pipeline.git .pipeline/toolkit
git submodule update --init --recursive
./.pipeline/toolkit/bin/pipeline init
# Optional: also install the generic GitHub Actions workflow pack.
./.pipeline/toolkit/bin/pipeline init --with-github-actions
```

`pipeline init` requires a Git repository and an initialized
`.pipeline/toolkit` submodule. It also checks for Node, pnpm, Claude Code,
authenticated GitHub CLI access, and tmux.

### 2. What `pipeline init` does

1. Installs dependencies only in the toolkit workspace from its lockfile.
2. Builds `@kampus/pipeline-cli` and typechecks `@kampus/pipeline-crew-mcp`.
3. Merges pipeline hook entries into `.claude/settings.json` without removing
   unrelated existing settings.
4. Creates `.glossary/LANGUAGE.md` from the toolkit's source template when the
   consumer does not already own that file; it never replaces an existing copy.
5. Creates managed links for every extracted `kampus-pipeline` skill and agent,
   then every `pipeline-crew` agent and command.
6. Creates `.claude/crew.config.template.jsonc` from the placeholder-only
   toolkit template when it does not already exist. It never creates the
   runtime config automatically.
7. Adds `crew.config.jsonc` and `crew-run/` to `.claude/.gitignore`.
8. Records all managed links in `.pipeline/pipeline.json`.

`--with-github-actions` additionally writes the optional generic workflows into
`.github/workflows/` when those paths do not already exist. Once installed,
`pipeline sync` preserves them and never replaces consumer edits.

Run the following after filling the crew configuration:

```bash
cp .claude/crew.config.template.jsonc .claude/crew.config.jsonc
# fill every <placeholder> in .claude/crew.config.jsonc
./.pipeline/toolkit/bin/pipeline init --check
```

`pipeline sync` currently performs the same reconciliation as `init`; use it
after advancing the submodule pointer.

### 2a. Optional generic GitHub Actions pack

The optional pack deliberately excludes Phoenix deployment, application-path,
Cloudflare, release, and approval-topology workflows. It contains only:

- `pipeline-toolkit.yml` — checks out the consumer with its submodule, installs
  the pinned toolkit workspace, and runs the toolkit package test suites.
- `pipeline-doc-safety.yml` — scans changed Markdown, ADR, pattern, and
  glossary files for machine-local-path leaks using the pinned local CLI.

The pack is a starting CI baseline. Repositories may add their own application
tests and deployment workflows without changing toolkit-managed files.

### 3. Run the toolkit

```bash
# Pipeline CLI command router
./.pipeline/toolkit/bin/pipeline cli <tool> [arguments]

# Crew runtime
./.pipeline/toolkit/bin/pipeline crew stand-up
./.pipeline/toolkit/bin/pipeline crew spawn-role <role>
./.pipeline/toolkit/bin/pipeline crew stand-down
```

The local hook wrapper resolves the same submodule from
`$CLAUDE_PROJECT_DIR/.pipeline/toolkit`. If the checkout is absent during a
partial bootstrap, guards fail open instead of blocking a Claude session.

## Plugin: `kampus-pipeline`

This plugin describes an issue-driven agent workflow. Its core conveyor belt is:

```text
report → triage → plan-epic → review-plan → write-code
       → review-code / review-doc / review-skill → ship-it
```

Its durable hand-offs are GitHub issues, labels, comments, pull requests, and
review verdicts rather than private agent memory. That lets a new agent resume a
stage from repository state.

### Included material

- **Agents:** ADR, canon, coder, planner, reporter, reviewer, shipper, and
  triager roles.
- **Workflow skills:** `report`, `triage`, `plan-epic`, `review-plan`,
  `write-code`, `review-code`, `review-doc`, `review-skill`, `review-design`,
  `review-trivial`, and `ship-it`.
- **Supporting skills:** `adr`, `architecture-audit`, `author-skill`,
  `campaign`, `canon`, `deslop-comments`, `diataxis`, `doctor`, `glossary`,
  `heal-ci`, `release`, `rite-audit`, `wayfinder`, `what-shipped`, and
  `writing-clearly-and-concisely`.
- **Shared contracts and validation:** GitHub intake formats, cycle/gate/skill
  validators, the doctor helper, report footer, and rite-audit assets.
- **Hooks:** session-start readiness checks, pre-tool worktree/spawn guards,
  worktree reaping, and a custom worktree creator.

The hooks execute local CLI guards such as `worktree-guard`, `worktree-sweep`,
and `spawn-guard`. The worktree creator fetches the target repository's `main`
and creates an isolated worktree under `.claude/worktrees/`.

## Plugin: `pipeline-crew`

`pipeline-crew` turns the workflow into a configurable multi-session operating
model. The plugin itself is intentionally thin: its commands and agents explain
how to operate the crew, while the runtime mechanics live in
`@kampus/pipeline-crew-mcp`.

### Roles

| Role | Kind | Purpose |
|---|---|---|
| Chief of staff | singleton bridge | Coordinates the operator-facing seam. |
| Cartographer | singleton, on-demand | Human-in-the-loop exploration and wayfinding; not started by the standing roster. |
| Intake desk | singleton bridge | Owns intake/triage-facing coordination. |
| Engineering manager | scalable engine | Executes independent work lanes; `count` and WIP caps come from configuration. |

`crew-investigator.md` is an available agent definition, but it is not one of
the four runtime roster roles declared by `pipeline-crew-mcp`.

### How the crew workflow runs

The crew is a continuous **backlog-to-merged-work loop**. Its durable source of
truth is the target repository's GitHub state: issues, labels, plans, pull
requests, review verdicts, and merge state. MCP channel messages are only
delivery/wake-up signals; an acknowledgement means a message reached an inbox,
not that a role read it or that its contents are true.

```text
fuzzy direction ──> cartographer ──> wayfinder map/frontier ──┐
                                                               │
new observation / issue ───────────────────────────────────> intake desk
                                                               │
                              report → triage → plan          ▼
                                                   GitHub-ready backlog
                                                               │
                                         claim one lane        ▼
                                              engineering manager × N
                                                               │
                                         coder → reviewer → shipper
                                                ▲       │        │
                                      review FAIL ──────┘        ▼
                                                       merged PR / closed issue
                                                               │
chief of staff <──── verifies live GitHub state ───────────────┘
        │
        └── verified update to the operator or approval request to the approver
```

The roles deliberately have narrow responsibilities:

1. **Cartographer — discover work, not implementation.** It is launched on
   demand when the operator has a fuzzy destination. It runs `wayfinder` to
   turn that uncertainty into a map and concrete frontier tickets. When work is
   ready for the normal queue it sends an `IntakePing` to the intake desk. It
   never routes work straight to an engineering manager, because that would
   bypass triage.
2. **Intake desk — make work actionable.** It watches incoming observations and
   charted work, then uses the issue pipeline (`report`, `triage`, and planning
   when required) to produce a classified, scoped, pickable backlog item. Its
   output is repository state, not a private conversation.
3. **Engineering manager — drain ready work.** Each engine instance claims one
   available lane through the tracker before working it, which prevents two
   engines from taking the same lane. It drives the execution chain by spawning
   implementation, review, and shipping work. The configured engine count and
   WIP caps limit how much can run concurrently.
4. **Coder, reviewer, shipper — execute one lane safely.** A coder prepares the
   branch and pull request. An independent reviewer records a verdict for the
   current PR head. A FAIL returns to the coder on the same lane; only a PASS
   allows the shipper to enqueue or merge according to the repository's rules.
5. **Chief of staff — report verified reality.** It reads the board and PR state
   before communicating with humans. It does not treat a peer's message as
   proof. For approval-gated work, it brings the current PR to the configured
   approver; the shipping path resumes only after the required approval is on
   the current commit.

The standing `stand-up` roster starts the chief of staff, intake desk, and the
configured number of engineering managers. The cartographer is intentionally
human-in-the-loop and starts only through `spawn-role cartographer`; it comes up
idle until the operator gives it a mapping task.

If a channel message fails, the receiving role can still find the work by
reading the GitHub board on its next loop. That makes channels a latency
optimization rather than a correctness dependency.

### Operator configuration

Copy `.claude/crew.config.template.jsonc` to the ignored, operator-owned
`.claude/crew.config.jsonc`. The filled runtime configuration must supply:

- operator and control-plane approver identities;
- model tier and engine count/WIP caps for roles;
- notification commands and handles;
- optional exact Claude Code version pin;
- channel mode, server references, and allowed channel plugins.

The crew commands are:

- `stand-up` — validate configuration, ensure the per-project tracker, derive
  the configured roster, register project-scoped channel configuration, and
  launch the complete roster in tmux. It aborts before launching any session
  when a precondition fails.
- `spawn-role <role>` — add one role to an already-running crew, including the
  on-demand cartographer or an additional engine.
- `stand-down` — remove launcher-owned project-scope configuration and tear
  down the crew registration.

## Package: `@kampus/pipeline`

This is the bootstrap package behind `bin/pipeline`. It is the boundary between
an adopting repository and the toolkit implementation.

Its commands are:

| Command | Meaning |
|---|---|
| `init [--project-root <path>] [--force] [--check]` | Install/validate the toolkit and generate or reconcile project-local wiring. |
| `sync` | Alias for initialization/reconciliation after changing the pinned submodule revision. |
| `check [path]` | Validate prerequisites and generated configuration without changing files. |
| `cli <tool> …` | Forward to the copied `pipeline-cli` command router. |
| `crew <command> …` | Forward to the crew MCP runtime. |

## Package: `@kampus/pipeline-cli`

This package is the single command router for pipeline automation. It uses a
registry of Effect CLI commands; `commands compact` is the authoritative runtime
index after dependencies are installed.

The copied command set includes these broad groups:

| Group | Examples |
|---|---|
| Issue and planning operations | `tracker`, `claim`, `intake-dedup`, `intake-compose`, `split-guard`, `epic-lock`, `epic-ledger`, `epic-splice`, `wayfinder-map`, `roadmap` |
| Review and merge gates | `verdict`, `review-head`, `unresolved-threads-guard`, `leak-guard`, `trivial-diff`, `class-probe`, `ci-required`, `merge-queue-classify` |
| Worktree and agent safety | `worktree-guard`, `worktree-sweep`, `spawn-guard`, `ref-guard`, `main-sync`, `resume-policy`, `token-spend` |
| Documentation and repository rules | `decisions-index`, `glossary-drift`, `readme-guard`, `catalog-guard`, `patch-guard`, `settings-env-guard`, `workflow-contract` |
| Control-plane and workflow analysis | `control-plane-paths`, `cp-cardinality`, `codeowners-cp`, `reachability-guard`, `fanout-guard`, `crew-fanout-guard` |
| Reporting and diagnostics | `commands`, `version`, `eval-harness`, `failure-classifier`, `ship-digest`, `changelog-derive`, `orphan-heal` |
| Design and adoption checks | `design-inventory`, `design-token-guard`, `adoption-lint`, `campaign`, `change-detect-guard`, `pointer-guard`, `primary-index-guard` |

Most tools have a pure, unit-tested decision core and a thin Git/GitHub/CLI
boundary. Several make GitHub REST calls through `gh`; any command that changes
issues, labels, comments, branches, PRs, or merge state should be treated as an
intentional workflow action, not a background side effect.

## Package: `@kampus/pipeline-crew-mcp`

This is the crew's runtime substrate. It provides:

- a per-project local tracker and rendezvous socket;
- peer and channel communication primitives;
- an MCP channel edge for crew sessions;
- configuration parsing and placeholder validation;
- role/lease and session-set derivation;
- tmux placement, project-scope MCP registration, launch, reap, and teardown;
- fail-closed stand-up and single-role lifecycle commands.

The crew package is private and is called through the bootstrap rather than
installed globally. It requires a valid Git project root, configured channels,
tmux, a working Claude CLI, and a complete crew config before it will launch.

## Current extraction state

This repository now contains **complete verbatim copies** of the two plugin
payloads and the two implementation packages from Phoenix (dependency caches
are deliberately excluded). That preserves every skill, agent, command,
supporting document, test, and runtime source file while the portable project is
being established.

This also means some copied source prose and tools still refer to inherited
workflow policy, labels, paths, marketplaces, release behavior, or other
source-repository conventions. Those copied files are not yet proof that every
workflow is portable or generic. The project-local bootstrap and runtime path
are the portable layer; extracting and deciding which inherited policies should
remain is a separate, deliberate follow-up.

### Important current validation gap

The complete package extraction added the CLI's `fast-xml-parser` and `yaml`
catalog entries. The workspace lockfile and local dependency tree still need a
fresh approved `pnpm install` before the copied CLI and crew package typechecks
can be run end-to-end. Until then, `pipeline init`'s frozen-lockfile install may
fail on a clean consumer checkout.

Do not solve this by publishing packages or installing them globally. Regenerate
and commit the private toolkit's lockfile, then validate the workspace locally.

## Definition of done for the portable toolkit

The portable v1 is complete when all of the following are true:

1. A clean, unrelated Git repository can add this private submodule and run
   `pipeline init` with no global install and no package-registry lookup for the
   pipeline packages themselves.
2. Initialization is repeatable, preserves unrelated `.claude` content, and
   records every managed path.
3. `pipeline init --check` passes after valid crew configuration is supplied.
4. Generated hooks, commands, skills, agents, and crew launch paths resolve the
   pinned local toolkit only.
5. Every retained workflow and CLI tool has been reviewed for generic behavior;
source-repository-specific policy has either been removed, isolated behind an
explicit profile, or intentionally retained and documented.
6. The lockfile is current, the complete workspace installs from it, and package
   typechecks/tests pass in a clean fixture consumer.

## Maintenance workflow

1. Make and test changes in this private repository.
2. Commit and push a toolkit revision.
3. In each adopting repository, update the `.pipeline/toolkit` submodule SHA.
4. Commit that submodule-pointer update in the adopting repository.
5. Run `./.pipeline/toolkit/bin/pipeline sync`.
6. Run `./.pipeline/toolkit/bin/pipeline init --check` after configuration or
   runtime changes.

This gives each consumer a reproducible toolkit version and makes upgrades
visible in normal Git review.
