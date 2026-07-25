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
`pipeline init` installs only the pinned toolkit workspace, writes the
project-local Claude wiring, creates `.claude/crew.config.template.jsonc`, and
adds the `pipeline` script to the adopting repository's `package.json`.

From this point onward, use one consistent command interface:

```bash
pnpm pipeline <command>
```

## Configure and validate the crew

The template is deliberately not a live configuration. Create the ignored,
operator-owned copy and fill its values:

```bash
cp .claude/crew.config.template.jsonc .claude/crew.config.jsonc
# Fill the operator, roles, channels, and optional Claude Code version.

pnpm pipeline crew check-config
pnpm pipeline init --check
```

`crew check-config` validates the fields used to launch the crew without
starting tmux, a tracker, or any crew session. `init --check` verifies the
toolkit submodule, generated project wiring, required local commands, and the
absence of template placeholders.

## Daily use

```bash
# Start or stop the configured crew.
pnpm pipeline crew stand-up
pnpm pipeline crew stand-down

# Run a pipeline CLI tool or another crew lifecycle command.
pnpm pipeline cli <tool> ...
pnpm pipeline crew <command> ...
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

To add the optional generic GitHub Actions baseline (toolkit verification and
documentation-path safety), opt in explicitly:

```bash
pnpm pipeline init --with-github-actions
```

It writes only `.github/workflows/pipeline-toolkit.yml` and
`.github/workflows/pipeline-doc-safety.yml`, and never replaces a consumer
workflow that already exists.
