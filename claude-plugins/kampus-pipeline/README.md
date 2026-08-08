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
│   ├── optional-workflow-policy.json # consumer opt-in policy; disabled by default
│   └── toolkit/                    # pinned private Git submodule
├── CLAUDE.md                       # repository-owned contributor guidance
├── .decisions/README.md            # architecture-decision surface
├── .patterns/index.md              # code-pattern surface
└── .claude/
    ├── skills/                     # managed links to portable-core skills only
    ├── agents/                     # managed links to portable-core agents
    └── settings.json               # existing settings preserved; pipeline hooks merged
```

The links are managed paths recorded in `.pipeline/pipeline.json`. Re-running
`pipeline init` or `pipeline sync` adds missing portable-core links without
replacing user files. `--force` can replace only paths already recorded in that
manifest. The full workflow archive remains in the pinned toolkit submodule;
the catalog marks it as adapter-required and it is never linked into
`.claude/skills` by default.

On a clean repository, initialization also creates neutral starting documents
for the repository's contributor guidance, architecture decisions, and code
patterns. Those documents become repository-owned: an existing consumer copy is
preserved, and the toolkit does not replace later consumer edits.

After initialization, use the project-local command installed in the adopting
repository's `package.json`:

```bash
pnpm pipeline init --check
pnpm pipeline sync
pnpm pipeline cli <subcommand>
```

There is deliberately no `npm install` of a published package, no `pnpm dlx`, public
publishing, global plugin installation, or marketplace catalog in this
workflow. A clone that already contains the submodule is self-contained.

## How skills resolve a target repository

Skills operate on the current Git repository by default. Set
`CLAUDE_PIPELINE_REPO=owner/repo` only when the repository you intend to act on
is not the current checkout (for example, when working from a fork).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

Bootstrap prerequisites are Git, Node, and pnpm. Claude Code, tmux, GitHub
authentication, release platforms, and product-audit tooling are optional
workflow requirements: a repository enables and documents them in its
`.pipeline/optional-workflow-policy.json` adapter before using the matching
archived workflow. `pipeline init --check` reports only bootstrap wiring
without changing the repository.

## Worktree isolation

The generated Claude `WorktreeCreate` hook creates an additional checkout under
`.claude/worktrees/<name>`. It derives a base from the current branch's upstream
when available, otherwise the remote's default branch, and finally the local
`HEAD`. It initializes declared submodules in that checkout. It does not assume
an `$PIPELINE_BASE_REF` branch, Lefthook, a package manager, or a particular
application layout.

This lets concurrent agents edit and commit separate branches without changing
the configured base branch working directory. It is unrelated to reading GitHub issues or pull
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
