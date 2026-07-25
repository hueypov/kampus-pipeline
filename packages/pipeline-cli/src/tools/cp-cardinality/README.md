# cp-cardinality

`pipeline-cli cp-cardinality decide` — the deterministic §CP discharge decision
**ship-it's control-plane approval gate** runs, keyed on `@kamp-us/control-plane` team
cardinality. It requires the approval signal appropriate to the active team shape,
and every signal must apply to the PR's current head.

## Why it exists

The §CP gate (the approval rule: a non-author control-plane approval at the current head is required before the pipeline enqueues the change)
models the control-plane team as exactly two humans and requires the *other* member's
approval. It never specified the degenerate shapes — one present member, or zero — so
agents resolved them by **judgment**, and the same conditions produced opposite verdicts
across runs under identical single-owner conditions. A gate whose verdict depends on
which agent ran it is not a gate.

This tool makes discharge a pure function of team shape, unit-tested at every boundary,
so ship-it's gate is reproducible: same inputs → same decision.

## The branch

`N` = count of distinct, active, human `@kamp-us/control-plane` members.

| Shape | Discharge signal |
| --- | --- |
| `N == 0` (empty team) | **none** — STOP, fail closed (no accountable human) |
| `N == 1`, sole owner **is** the PR author | a current-head **self-approval marker** by the sole owner |
| `N == 1`, sole member **is not** the author | that member's current-head **approval** |
| `N >= 2` | a current-head **APPROVED review by a different** control-plane member; a self-approval never counts |

A self-approval discharges **only** in the `N == 1` sole-owner case — never when `N >= 2`
— and every stale (non-current-head) signal is excluded upstream by ship-it's
current-head binding, never regressed here.

## Split of concerns

IO in the thin bin (`command.ts`), the whole policy in the pure core
(`cp-cardinality.ts`) — the same split `class-probe` uses for ship-it Step 0. **ship-it**
owns the `gh api` REST resolution (the member roster, the PR author/head SHA, and the two
current-head signals — a different-member APPROVED review and the sole-owner self-approval
marker); this tool owns the branch. It never calls the network.

## Usage

```bash
# ship-it's §CP gate resolves the roster + signals over REST, then decides deterministically:
ORG="${REPO%%/*}"
MEMBERS="$(gh api --paginate "orgs/$ORG/teams/control-plane/members?per_page=100" --jq '.[].login')"
printf '%s\n' "$MEMBERS" | pipeline-cli cp-cardinality decide \
  --author "$AUTHOR" \
  --non-author-approval-at-head \   # pass iff a current-head APPROVED review by a member != author exists
  --self-approval-at-head           # pass iff a current-head self-approval marker by the sole owner exists
```

The decision word (`discharge` | `stop`) goes to **stdout**; a human reason goes to
**stderr**. Exit is **0 on `discharge`, 1 on `stop`**, so the gate bash fails closed with
`… && carry-on || STOP`.
