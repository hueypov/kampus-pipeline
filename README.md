# kampus-pipeline

Private, project-local pipeline tooling. This repository is consumed as a Git
submodule at `.pipeline/toolkit`; it is not published to npm and never installs
a global `pipeline` executable.

## New repository setup

Run these commands from the root of an initialized Git repository. For a new
empty directory, run `git init` first:

```bash
# Only for a new repository:
git init
git submodule add git@github.com:hueypov/kampus-pipeline.git .pipeline/toolkit
./.pipeline/toolkit/bin/pipeline init
```

`git submodule add` both records and initializes the submodule. The first
`pipeline init` installs only the pinned toolkit workspace, links the audited
Kampus Pipeline core skills and agents into `.claude`, writes project-local
Claude wiring that calls hooks from the pinned submodule, seeds neutral
repository guidance, decision and pattern documentation, architecture and
domain glossaries, and adds the `pipeline` script to the adopting repository's
`package.json`. Retained archive workflows remain inside the toolkit and are
not exposed as consumer skills without a repository-owned adapter.

From this point onward, use one consistent command interface:

```bash
pnpm pipeline <command>
```

## Optional integrations

The default payload is intentionally limited to generic architecture and writing
workflows. It does not install a crew, a release platform, or application-specific
skills. Those capabilities need a repository-owned adapter with its own configuration
and validation; they are not implied by `pipeline init`.

The linked agents use GitHub when their issue, pull-request, review, or shipping
workflow calls for it. The installed generic policy enables the core delivery
stages; repository-specific queue queries, labels, protected paths, approver
topology, and external adapters remain intentionally unset until the repository
declares them. Crew, release-platform, and application-specific plugin directories
remain optional; `pipeline init` does not link them or create their configuration.

`pipeline init` also installs a generic delivery-gate workflow. It requires a
current-head `review-code` PASS for every PR, adds `review-doc` and `review-skill`
for matching changed files, and adds `review-design` for paths declared in
`github.review.uiPaths`. `github.review.requiredChecks` is the repository-owned
list of additional check names that must pass on the same current head.

`pnpm pipeline init --check` verifies the pinned submodule and the generated core
wiring. It requires Node.js 22.6 or later and pnpm, but not GitHub authentication
or a user-level Claude configuration.

It also verifies the terminal a crew would launch into, but only once the crew
config has been personalized: a config that still carries `<placeholders>` is
skipped, so a repository that never stands a crew up is never asked to install a
terminal. When the config is filled, the check resolves its `terminal` dimension
(`tmux` by default, or `herdr`) and reports an unsupported value or a missing
binary — catching at install time what would otherwise fail the whole stand-up.

`pnpm pipeline status` shows the same local installation contract in a readable
form; `pnpm pipeline status --json` is the machine-readable form. It distinguishes
installed core artifacts, missing or drifted links, optional workflows that are
disabled, and optional workflows that are linked but still require a repository
adapter. The linked `.pipeline/workflow-catalog.json` describes the portable
catalogue and remains pinned to the toolkit; it is not an adopter policy file.

The generated `.pipeline/cli-capability-matrix.md` records the portable lifecycle
tools and the repository/product adapters that remain deliberately deferred.
`main-sync` and `worktree-sweep` are dry-run by default; `trivial-diff classify`
is fail-closed and does not route a PR to the lighter review gate unless a
repository explicitly enables and wires that policy.

The generated document-safety workflow validates ADR filename and frontmatter
consistency with the pinned local `decisions-index` command. ADR agents use
GitHub only when coordinating an ADR pull request; no organisation-specific
labels, boards, or approval policy are implied.

## Daily use

```bash
# Run a local toolkit command.
pnpm pipeline cli <tool> ...
```

## Self-hosting (this repository)

This repository runs the pipeline on itself. Instead of a pinned submodule,
`.pipeline/toolkit` is a relative symlink back to the repository root, so every
consumer-shaped path — hooks, skills, managed links, `pnpm pipeline` — resolves
through it to the live working tree:

```bash
# From the repository root. The link target resolves relative to `.pipeline/`,
# so the repository root is `..`, not `../..`.
mkdir -p .pipeline && ln -s .. .pipeline/toolkit
git add .pipeline/toolkit
git commit -m "Self-host the pipeline toolkit"
./bin/pipeline init
```

Committing the symlink is part of the bootstrap, not an optional tidy-up. Git
tracks it as a symlink, so every linked worktree checks it out, and `..`
resolves to that worktree's own live tree. An untracked symlink is absent from
every worktree — and with no `.gitmodules` there is no submodule for the
worktree-create hook to initialize instead — so the toolkit's own
agent-worktree workflow would find no pipeline at all. For the same reason,
commit the surfaces `init` materializes (`.pipeline/pipeline.json`,
`.claude/settings.json`, the managed links, the `pipeline` script in
`package.json`), exactly as adopters commit theirs, so `pipeline check` holds
inside a fresh worktree too.

Initialization installs the full consumer payload — agents, skills, hooks, and
the document surfaces — with no self-host-only minimal mode. The submodule
assertion is the one check that does not apply, because a repository cannot be
its own submodule; everything else behaves exactly as in an adopter. The
optional workflow templates are never materialized here: `pipeline enable`
refuses them, `init`/`sync` refuse a policy that enables one, and `check`
reports an enabled one as drift — a consumer-shaped workflow in this repository
would test a checkout of itself, green and confirming nothing. This
repository's build signal is `.github/workflows/ci.yml`.

## Clone an adopting repository

When cloning a repository that already uses this toolkit, clone its pinned
submodule in the same operation:

```bash
git clone --recurse-submodules <repository-url>
cd <repository-directory>
pnpm pipeline init --check
```

If it was cloned without submodules, initialize the recorded one once:

```bash
git submodule update --init --recursive
pnpm pipeline init --check
```

## Update the toolkit revision

Toolkit updates are deliberate: choose a toolkit commit, update the submodule
pointer, commit that pointer in the adopting repository, then reconcile local
wiring:

```bash
cd .pipeline/toolkit
git fetch
git checkout <approved-commit>
cd ../..

git add .pipeline/toolkit
git commit -m "Update pipeline toolkit"
pnpm pipeline sync
pnpm pipeline init --check
```

Initialization writes no workflow unless the repository asks for one — a check
nobody chose is still a check nobody chose. Enable them by name:

```bash
./.pipeline/toolkit/bin/pipeline enable pipeline-verify
```

`pipeline-verify` is the one that completes the pipeline: it runs a
repository-owned `.pipeline/verify.sh`, and without a check reporting on a head
`ship-it` refuses every merge as unconfirmed. Initialization never replaces a
consumer workflow that already exists.
