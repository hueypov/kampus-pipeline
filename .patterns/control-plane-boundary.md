# The configured control-plane boundary

The §CP control-plane set is *described* in
`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` and *enforced* from
`github.shipping.controlPlanePaths` in `.pipeline/agent-policy.json`. Every consumer — the
review gates, `ship-it`, and `trivial-diff route` — matches through
`pipeline cli protected-change-policy`, which reads that key from the trusted base ref. The prose
is the specification; this repository's policy file is the only thing the gates can act on, so the
two have to be transcribed in lockstep. They were not: the list shipped empty, and an empty list
answers `ordinary` for every input (#134).

## The three files, and which one is authoritative for what

| File | Role |
| --- | --- |
| `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` §CP | states the set; changing it changes what must be transcribed |
| `templates/pipeline/agent-policy.json` | the shipped default; stays empty, because a portable template cannot know an adopter's source taxonomy |
| `.pipeline/agent-policy.json` | this repository's own boundary; what the matcher actually reads |

An empty `controlPlanePaths` is **refused**, not honoured
(`packages/pipeline-cli/src/tools/protected-change-policy/policy.ts`). A boundary that protects
nothing is indistinguishable from an unconfigured one, so it resolves to the same untrusted result
as a missing or malformed policy: `classify` prints `protected`, `regex` prints the match-all `.`,
and `trivial-diff route` selects `full-review`. That is what keeps the shipped empty default from
being a gate that passes without checking — an adopter who has not named a boundary gets manual
merge on everything, loudly, instead of auto-merge on everything, silently.

## Clauses that currently match no path here

The transcription follows the §CP prose clause for clause, including four clauses with nothing to
match in this repository today: `packages/ci-required/`, the `release` skill, `biome.jsonc`, and
`biome-plugins/`. They are kept because the prose names them and because the failure direction of
an absent clause is fail-open — if one of those paths is reintroduced, it is protected on arrival
rather than on somebody noticing.

`^packages/pipeline-cli/` is the **whole** package and must not be narrowed to a `src/guards/`
sub-prefix: the guard dispatch (`registry.ts`, `router.ts`, `bin.ts`) sits at the package root, so
an edit there can disable every guard.

## Managed-path sync does not overwrite this file

`.pipeline/agent-policy.json` is declared in `.pipeline/pipeline.json` as materialized from
`template:templates/pipeline/agent-policy.json`, which raises the question of whether a later
`pipeline init` / `sync` reverts a populated boundary. It does not. `materializeTemplate` in
`packages/pipeline/src/bin.ts` writes only when the destination does **not** exist and takes no
force flag, and `retireUnmanagedPaths` deletes only a symlink it recorded itself, never a
materialized file. `packages/pipeline/src/bin.test.ts` pins both halves: an adopter-edited policy
survives `init` and `sync`. So the boundary is durable where it is, and does not need a
sync-immune home.

## `github.review.uiPaths` is empty on purpose

The design gate (`review-design`) applies to declared rendered surfaces. This repository ships a
CLI, an MCP server, agent definitions, and prose — there is no rendered surface, so there is no
path that a design review could be about, and an unconfigured `.tsx`/`.css` is deliberately *not*
design-gate work. The empty list is therefore the correct configuration rather than an omission,
and it stays empty until this repository grows a rendered surface; adding one means populating
`uiPaths` in the same change.

## The approval authority is the other half, and is owned elsewhere

A working protected-change approval gate needs both a path set (here) and a resolvable approver.
The two halves are owned separately and land independently, which is why the boundary work does not
edit the authority key.

The authority half is already settled: `github.shipping.protectedChangeApproval.authority` carries
`{"provider": "github-collaborators", "organization": null, "teamSlug": null}`, landed by #106. That
provider resolves the approver set from the repository's own collaborators, so the null
`organization` and `teamSlug` are correct rather than unconfigured — this repository is not in a
GitHub org and has no review team. Populating the path set therefore makes protected changes
*gateable*, not unmergeable.

Both providers fail closed on an authority they cannot resolve: a protected change whose approver
set is unresolvable is merged by a human, which is the §CP posture either way.
