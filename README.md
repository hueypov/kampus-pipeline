# kampus-pipeline

Private, project-local pipeline tooling. This repository is consumed as a Git
submodule at `.pipeline/toolkit`; it is not published to npm and never installs
a global `pipeline` executable.

## New repository setup

Run these two commands once in the root of the repository adopting the toolkit:

```bash
git submodule add git@github.com:hueypov/kampus-pipeline.git .pipeline/toolkit
./.pipeline/toolkit/bin/pipeline init
```

`git submodule add` both records and initializes the submodule. The first
`pipeline init` installs only the pinned toolkit workspace, creates
consumer-facing `claude-plugins/<plugin>` links, links the Kampus Pipeline agents
into `.claude/agents`, writes project-local Claude wiring against those links,
seeds neutral architecture and domain glossaries, and adds the `pipeline` script
to the adopting repository's `package.json`.

From this point onward, use one consistent command interface:

```bash
pnpm pipeline <command>
```

## Optional integrations

The default payload is intentionally limited to generic architecture and writing
workflows. It does not install a crew, a release platform, or application-specific
skills. Those capabilities need a repository-owned adapter with its own configuration
and validation; they are not implied by `pipeline init`.

`pnpm pipeline init --check` verifies the pinned submodule and the generated core
wiring. It requires Node.js 22.6 or later and pnpm, but not GitHub authentication,
tmux, or a user-level Claude configuration.

## Daily use

```bash
# Run a local toolkit command.
pnpm pipeline cli <tool> ...
```

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

Initialization also writes the generic GitHub Actions baseline:
`.github/workflows/pipeline-toolkit.yml` and
`.github/workflows/pipeline-doc-safety.yml`. It never replaces a consumer
workflow that already exists.
