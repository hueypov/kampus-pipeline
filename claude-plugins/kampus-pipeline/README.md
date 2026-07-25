# kampus-pipeline

`kampus-pipeline` is the project-local workflow payload in the private
`kampus-pipeline` toolkit. It supplies reusable Git, GitHub, planning, review,
and repository-knowledge skills to an adopting repository. It is not a public
package, a registry dependency, or a globally installed Claude plugin.

## Install in a repository

From the adopting repository root, add the private toolkit once and initialize
it:

```bash
git submodule add git@github.com:hueypov/kampus-pipeline.git .pipeline/toolkit
./.pipeline/toolkit/bin/pipeline init
```

`pipeline init` creates the project-local wiring:

```text
your-repository/
├── .pipeline/
│   ├── pipeline.json               # managed manifest and toolkit location
│   └── toolkit/                    # pinned private Git submodule
├── claude-plugins/
│   └── kampus-pipeline -> ../.pipeline/toolkit/claude-plugins/kampus-pipeline
└── .claude/
    ├── skills/                     # managed links to the toolkit skills
    ├── agents/                     # managed links to the toolkit agents
    └── settings.json               # existing settings preserved; pipeline hooks merged
```

The links are managed paths recorded in `.pipeline/pipeline.json`. Re-running
`pipeline init` or `pipeline sync` adds missing links without replacing user
files. `--force` can replace only paths already recorded in that manifest.

After initialization, use the project-local command installed in the adopting
repository's `package.json`:

```bash
pnpm pipeline init --check
pnpm pipeline sync
pnpm pipeline cli <subcommand>
```

There is deliberately no `npm install @kampus/...`, `pnpm dlx`, public
publishing, global plugin installation, or marketplace catalog in this
workflow. A clone that already contains the submodule is self-contained.

## How skills resolve a target repository

Skills operate on the current Git repository by default. Set
`CLAUDE_PIPELINE_REPO=owner/repo` only when the repository you intend to act on
is not the current checkout (for example, when working from a fork).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

The shared runtime prerequisites are Git, Node, pnpm, Claude Code, tmux, and an
authenticated GitHub CLI. `pipeline init --check` reports missing prerequisites
without changing the repository.

## Worktree isolation

The generated Claude `WorktreeCreate` hook creates an additional checkout under
`.claude/worktrees/<name>`. It derives a base from the current branch's upstream
when available, otherwise the remote's default branch, and finally the local
`HEAD`. It initializes declared submodules in that checkout. It does not assume
an `origin/main` branch, Lefthook, a package manager, or a particular
application layout.

This lets concurrent agents edit and commit separate branches without changing
the main working directory. It is unrelated to reading GitHub issues or pull
requests.

## Updating the toolkit

The adopter controls upgrades. Update the private submodule to a chosen commit,
commit that pointer in the adopting repository, then run:

```bash
pnpm pipeline sync
```

Nothing fetches or applies a newer toolkit revision automatically.

## Scope boundary

The portable toolkit keeps generic repository mechanics: Git/GitHub discovery,
worktree isolation, planning, review, shared vocabulary, and the optional crew
runtime. Repository-specific application paths, release systems, CI topology,
labels, feature-flag platforms, and deployment policy belong in the adopting
repository, not in this payload.
