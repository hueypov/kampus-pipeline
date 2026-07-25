# kampus-pipeline — project scope and architecture

## What this project is building

`kampus-pipeline` is a **private, project-local agent-workflow toolkit**. It is
not an npm product, global command, or globally installed Claude marketplace
plugin. An adopting repository pins a particular toolkit revision as a Git
submodule, initializes local wiring once, and runs everything from that pinned
checkout.

The intended outcome is that a repository can use a consistent set of generic
agent workflows without taking a dependency on the Phoenix repository, its
deployment stack, a host-level Claude configuration, or an npm publication.

```text
adopting Git repository
│
├── .pipeline/toolkit/             pinned Git submodule: this repository
├── .pipeline/pipeline.json        generated managed-file manifest
└── .claude/
    ├── settings.json              existing settings plus pipeline-owned hooks
    ├── skills/                    links to the portable core skills
    └── (consumer-owned integration configuration, if any)
```

The command that owns this setup is:

```bash
./.pipeline/toolkit/bin/pipeline init
```

## Design rules

- **Private distribution only.** Every workspace package is marked `private`.
  The supported distribution mechanism is a private Git repository and a
  submodule pointer committed by each consumer.
- **Project-local execution.** Hooks and any explicitly enabled integration invoke
  `.pipeline/toolkit/bin/pipeline`; they do not resolve toolkit packages from npm.
- **Pinned upgrades.** A consumer updates the submodule commit deliberately,
  commits that pointer, and runs `pipeline sync`. Nothing silently updates from
  a remote registry or branch.
- **Preserve consumer ownership.** Initialization merges pipeline-owned hooks
  into existing `.claude/settings.json`, records managed links in
  `.pipeline/pipeline.json`, and refuses to overwrite unknown files. `--force`
  is limited to paths already recorded as managed.
- **Explicit integrations.** Crew, release-platform, product-UI, and organization
  policy integrations are not installed by default. An adopting repository owns an
  explicit adapter and its configuration when it needs one.
- **No implied global install.** The project-local submodule flow in this file
  is authoritative for this repository, even where copied source documents
  mention an older marketplace-based installation path.

## Repository layout

| Path | Responsibility |
|---|---|
| `bin/pipeline` | Shell entry point that starts the bootstrap package with Node. |
| `packages/pipeline` | Private bootstrap: discovers the consumer repository, validates the submodule, installs/builds the portable core, generates Claude wiring, and forwards local CLI requests. |
| `packages/pipeline-cli` | Private TypeScript command router and its implementation/test suite for pipeline automation and guard tools. |
| `packages/pipeline-crew-mcp` | Private TypeScript crew substrate: tracker, peer/channel protocol, MCP edge, validated configuration, tmux launcher, and role lifecycle. |
| `claude-plugins/kampus-pipeline` | Candidate workflow material; only the audited portable-core skills are linked by default. |
| `claude-plugins/pipeline-crew` | Optional crew implementation material, not part of the default installation. |
| `templates/github/workflows` | Optional, project-agnostic GitHub Actions workflow pack installed only on request. |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml` | The only workspace dependency definition and reproducibility lock for the private toolkit. |

## Consumer workflow

### 1. Pin the toolkit

In the adopting repository:

```bash
git submodule add <toolkit-remote> .pipeline/toolkit
git submodule update --init --recursive
./.pipeline/toolkit/bin/pipeline init
# Optional: also install the generic GitHub Actions workflow pack.
./.pipeline/toolkit/bin/pipeline init --with-github-actions
```

`pipeline init` requires a Git repository, an initialized `.pipeline/toolkit`
submodule, Node.js 22.6 or later, and pnpm. GitHub authentication, tmux, a crew
configuration, and user-level Claude configuration are integration-specific rather
than bootstrap requirements.

### 2. What `pipeline init` does

1. Installs dependencies only in the toolkit workspace from its lockfile.
2. Builds `@kampus/pipeline-cli` from the pinned lockfile.
3. Merges pipeline hook entries into `.claude/settings.json` without removing
   unrelated existing settings.
4. Creates neutral `.glossary/LANGUAGE.md` and `.glossary/TERMS.md` templates
   when the consumer does not already own those files; it never replaces an
   existing copy.
5. Creates managed links only for the audited, portable core skills.
6. Adds a project-local `pipeline` script to `package.json`, preserving all
   existing scripts and refusing to replace a conflicting `pipeline` script.
   If the repository has no `package.json`, it creates a minimal private one.
7. Records all managed links and owned hooks in `.pipeline/pipeline.json`.

`--with-github-actions` additionally writes the optional generic workflows into
`.github/workflows/` when those paths do not already exist. Once installed,
`pipeline sync` preserves them and never replaces consumer edits.

After this first initialization, the `package.json` script provides the shorter
project-local form. It is still not a global executable:

```bash
pnpm pipeline cli commands compact
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

```

The local hook wrapper resolves the same submodule from
`$CLAUDE_PROJECT_DIR/.pipeline/toolkit`. If the checkout is absent during a
partial bootstrap, guards fail open instead of blocking a Claude session.

## Quarantined source material

The repository still contains copied workflow, CLI, and crew code for reference
and future adapter work. It is **not** the portable payload and must not be
treated as a supported consumer contract. In particular, issue-pipeline policy,
organization-specific reviews, release operations, product UI checks, and the
multi-session crew require a repository-owned integration with its own
configuration and validation.

The default installation contains only the core skills enumerated in
`packages/pipeline/src/payload.ts`, neutral glossary templates, and
project-local hook reconciliation. No crew configuration is generated, linked,
or written to user-level Claude settings.

## Package: `@kampus/pipeline`

This is the bootstrap package behind `bin/pipeline`. It is the boundary between
an adopting repository and the toolkit implementation.

Its commands are:

| Command | Meaning |
|---|---|
| `init [--project-root <path>] [--force] [--check]` | Install/validate the toolkit and generate or reconcile project-local wiring. |
| `sync` | Alias for initialization/reconciliation after changing the pinned submodule revision. |
| `check [path]` | Validate prerequisites and generated configuration without changing files. |
| `cli <tool> …` | Forward to locally retained CLI material. Its individual tools are not part of the portable-core contract unless an adapter documents them. |
| `crew <command> …` | Forward to the crew MCP runtime for an explicitly configured integration; it is not initialized by default. |

## Package: `@kampus/pipeline-cli`

This package is the local command router for both core hooks and quarantined
source utilities. `commands compact` is the authoritative runtime index, but it
is not a list of portable features. A consumer should invoke an additional CLI
tool only through a repository-owned adapter that documents its dependencies,
authority, and compatibility assumptions.

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

This repository retains copied source material while its portable core is being
established. Copied workflows are not evidence of portability: source-specific
release, UI, organization, and crew policy remains outside the default payload until
it is redesigned as an explicit repository-owned adapter.

### Important current validation gap

The workspace lockfile includes the copied CLI dependencies. `pipeline init` uses
that lockfile with `--frozen-lockfile`; a clean consumer fixture remains the
verification target for every change.

## Definition of done for the portable toolkit

The portable v1 is complete when all of the following are true:

1. A clean, unrelated Git repository can add this private submodule and run
   `pipeline init` with no global install and no package-registry lookup for the
   pipeline packages themselves.
2. Initialization is repeatable, preserves unrelated `.claude` content, and
   records every managed path.
3. `pipeline init --check` passes for a clean unrelated repository without a
   crew, GitHub login, or host-level Claude mutation.
4. Generated hooks and core skills resolve the pinned local toolkit only.
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
