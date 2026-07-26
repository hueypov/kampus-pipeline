---
name: campaign
description: >-
  Record an approved audit wave onto the roadmap as a bounded campaign — the intake ritual that turns a wave-labeled issue cluster approved by the designated approver into a milestone-backed campaign draining through the configured campaign lane. Given a wave label, run the ritual end to end: gate first on the approval trace through `$PIPELINE_CAMPAIGN_VERIFY_APPROVAL_COMMAND`, create/attach the campaign milestone and stamp it on the wave's issues, re-price those issues to $PIPELINE_CAMPAIGN_PRIORITY so they drain concurrent with the active delivery stream, and open a PR adding the campaign's row to $PIPELINE_CAMPAIGN_ROADMAP_PATH's `## Campaigns` section. Symmetric lifecycle — `active` (create) and `done` (complete): completing a campaign flips its roadmap row to `done` and closes the milestone, as guarded as starting one. INVOKER-AGNOSTIC — a human OR an agent may run it; the approval trace is the sole authorization (no human-only guard). Trigger on "campaign <wave-label>", "record the <wave> audit wave as a campaign", "start the campaign for <wave>", "complete the <wave> campaign", "campaign done <wave-label>", "/campaign".
---

# campaign

## Repository-owned integration contract

This optional workflow is reusable only when the consumer repository enables it in `.pipeline/optional-workflow-policy.json` and supplies its campaign adapter. Before any mutation, resolve the repository root and require: a designated approver identity in `$PIPELINE_CAMPAIGN_APPROVER_LOGIN`, a fail-closed approval-verifier command in `$PIPELINE_CAMPAIGN_VERIFY_APPROVAL_COMMAND`, the campaign priority and any priorities it may replace, `$PIPELINE_CAMPAIGN_ROADMAP_PATH`, `$PIPELINE_BASE_REF`, and the repository's roadmap-format / validation contract. The adapter owns its tracker labels, milestone policy, approval-marker grammar, base branch, and review authority.

If any of those values or the adapter is absent, stop before a read that relies on it or any mutation. Do not infer an approver, label, board, roadmap path, priority, branch, or approval grammar from the examples below. The invariant remains unchanged: a durable, wave-bound approval must verify before the campaign can be recorded or completed.

You are recording an **approved audit wave** onto the roadmap as a **bounded campaign** — a
milestone-backed push that drains through the configured campaign lane *concurrent* with the active delivery
stream (ADR
the repository strategic-sequencing decision
strategic-sequencing semantics; ADR
the repository delivery-priority decision
engineering-led). An audit wave enters as bulk `report`-filed issues sharing a **wave label**
(the [`report`](../report/SKILL.md) → [`triage`](../triage/SKILL.md) seams stay untouched;
wave-ness is that shared label). This skill is the small, release-precedent intake mechanism that
promotes such a wave into a campaign the roadmap knows about, in one guarded ritual: **gate →
milestone + assign → configured-priority re-price → $PIPELINE_CAMPAIGN_ROADMAP_PATH Campaigns-row PR.**

The designated approver ruling this skill discharges: audit-type intake (security/architecture audit waves)
must be *recorded to the roadmap* as bounded campaigns rather than draining invisibly (the
`## Campaigns` section, own milestone, platform-lane concurrency). The design question of *what
mechanism* resolved to this skill.

## INVOKER-AGNOSTIC — a human OR an agent may run it (no human-only guard)

Unlike [`release`](../release/SKILL.md), this skill has **no human-at-keyboard guard 0**. A human
*or* an autonomous agent may run it, because recording a campaign is not a control-plane act like
flipping production serving — it is the roadmap bookkeeping that follows an approval already
granted. What makes that safe is that the **approval trace is the *sole* authorization**:
the only thing that lets a wave become a campaign is a durable, designated approver-authored approval marker
bound to the wave label (the gate in Step 1). Whoever runs the ritual, the trace is what
authorizes it — so there is no second, invoker-shaped guard to satisfy, and the gate fails closed
for human and agent alike.

The trust anchor is the **designated approver identity**, injected as config, **never hardcoded** — no named
identity lives in this skill or any artifact it writes. Resolve it once, the same way the verifier
does (`--approver` flag, else `$PIPELINE_CAMPAIGN_APPROVER_LOGIN`):

```bash
APPROVER="${PIPELINE_CAMPAIGN_APPROVER_LOGIN:?set $PIPELINE_CAMPAIGN_APPROVER_LOGIN (or pass --approver) — the designated approver identity is the authorization anchor; refuse without it rather than fall back to any implicit login}"
```

Resolve `$REPO` the repo-agnostic way the rest of the pipeline does (ADR
the pipeline repository-resolution contract):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

All GitHub reads/writes below go through **`gh api` REST** — never GraphQL (the org's
configured planning-board integration errors GraphQL issue/PR queries, the standing pipeline constraint).

## Preconditions — the wave label, the lifecycle direction, the campaign name

You need three inputs before the ritual:

1. **The wave label.** A shared label naming the audit-wave cluster (e.g. `mentor-audit`). Every
   issue carrying it is a member of the wave. Confirm it names a non-empty cluster before you act:

   ```bash
   WAVE_LABEL="<the shared wave label>"
   gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
     --jq '.[] | select(.pull_request | not) | "#\(.number)\t\(.state)\t\(.title)"'
   ```

2. **The lifecycle direction — `active` (create) or `done` (complete).** Default is `active`
   (record a new campaign). Pass/say `done` to complete an existing campaign. The two paths are
   symmetric and both go through the same gate — see [Symmetric lifecycle](#the-symmetric-lifecycle--active-create-and-done-complete).

3. **The campaign name** — the approved display display name for the ROADMAP row (`Campaign` cell).
   For `done`, this is the name of the already-recorded row you're completing.

---

## Step 1 — Gate: verify the approval trace, fail closed

**Before any mutation** — before you create a milestone, stamp a label, re-price an issue, or open
the ROADMAP PR — call the fail-closed **approval-trace verifier** (the sibling child,
issue the repository-supplied approval verifier) against the wave label. It is the sole authorization for both the `active` and `done`
paths, and it **exits 0 only on a present, well-formed, designated approver-authored, wave-bound trace**;
every other input (absent, malformed, an author other than the designated approver, zero scope) exits non-zero (ADR
the repository fail-closed zero-scope rule):

```bash
"${PIPELINE_CAMPAIGN_VERIFY_APPROVAL_COMMAND:?set to the repository approval verifier}" "$WAVE_LABEL" --approver "$APPROVER" \
  || { echo "campaign: REFUSED — no valid approval trace for '$WAVE_LABEL'. The wave stays un-recorded." >&2; exit 1; }
```

The trace the verifier requires is a **designated approver-authored comment**, on any issue carrying the wave
label, whose first line is `campaign-approve: <wave-label> · <ISO-8601-UTC>` (the grammar is the
verifier's — the README under `packages/pipeline-cli/src/tools/campaign/` is the single source;
this skill *calls* the verifier, it never re-derives the marker). If the trace is absent, that is
the designated approver never having approved this wave — **stop and report it**, do not proceed to conjure a
campaign. This gate is the skill's load-bearing invariant, not advice: it is what makes the
skill safe to run invoker-agnostically.

If you are running the `done` path, run the **same gate** first — completing a campaign is as
guarded as starting one, so a wave with no approval trace can neither be created nor completed.

---

## Step 2 — Milestone: create or attach the campaign milestone

A campaign is pinned to its **own** GitHub milestone — the operational projection of the ROADMAP
row (the repository strategic-sequencing decision). Resolve the milestone with this precedence, and **never guess a product
milestone** (an arc's milestone from `## Arcs`) — a campaign runs concurrent with, not inside, a
active delivery stream:

- **An existing campaign milestone the designated approver curated** — if the designated approver already created a
  milestone for this wave, attach to it. List open milestones and match by title/description:

  ```bash
  gh api "repos/$REPO/milestones?state=all&per_page=100" --jq '.[] | "#\(.number)\t\(.state)\t\(.title)"'
  ```

- **Otherwise provision the campaign's own milestone** — the roadmap act the designated-approver approval
  authorizes. Create a dedicated milestone whose title is the campaign name (never reuse an arc
  milestone):

  ```bash
  MILESTONE_NUMBER=$(gh api -X POST "repos/$REPO/milestones" \
    -f "title=<Campaign name> campaign" \
    -f "description=<one-line campaign scope> (bounded, platform-lane drained)." \
    --jq .number)
  ```

Then **stamp the milestone on every wave-labeled issue** so the milestone projection matches the
cluster (the milestone is set per-issue via the issue-edit endpoint):

```bash
for N in $(gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
    --jq '.[] | select(.pull_request | not) | .number'); do
  gh api -X PATCH "repos/$REPO/issues/$N" -F "milestone=$MILESTONE_NUMBER" >/dev/null
done
```

**Assignments.** Record who owns the campaign's drain if the designated approver named owners (assign the wave
issues, or leave them to the normal unassigned-pick if the campaign drains through the pipeline).
The pipeline pick is milestone-aware (`work milestone N`), so pinning the milestone is what lets
[`write-code`](../write-code/SKILL.md) drain the campaign as a cohort.

---

## Step 3 — configured-priority re-price: price the wave to drain via the configured campaign lane

Re-price every wave issue to **`$PIPELINE_CAMPAIGN_PRIORITY`** so the campaign drains concurrent with the active delivery
stream through the configured campaign lane (the repository strategic-sequencing and delivery-priority decisions: `$PIPELINE_CAMPAIGN_PRIORITY` is relative to the active delivery stream, and the
campaign runs alongside whichever delivery stream is active). Replace the repository's configured superseded priorities with `$PIPELINE_CAMPAIGN_PRIORITY` on each
wave issue:

```bash
for N in $(gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
    --jq '.[] | select((.pull_request | not) and .state=="open") | .number'); do
  for P in $PIPELINE_CAMPAIGN_REPLACED_PRIORITIES; do gh api -X DELETE "repos/$REPO/issues/$N/labels/$P" >/dev/null 2>&1; done
  gh api -X POST "repos/$REPO/issues/$N/labels" -f "labels[]=$PIPELINE_CAMPAIGN_PRIORITY" >/dev/null
done
```

Only open issues need re-pricing — a closed wave issue has already drained and its priority is
moot.

---

## Step 4 — $PIPELINE_CAMPAIGN_ROADMAP_PATH Campaigns-row PR

The campaign becomes visible on the roadmap by **a PR that edits `$PIPELINE_CAMPAIGN_ROADMAP_PATH`'s `## Campaigns`
table** — the parsed contract the `repository roadmap validation gate` CI gate binds to (the ROADMAP format is the
sibling child the repository roadmap-format contract; this skill targets its pinned grammar, it does not redefine it). The table's
columns are `Campaign | Milestone | State`, the milestone pinned **by number** (`#N`), and
`State ∈ {active, done}`.

Branch off the fresh configured base ref, edit the table, and open the PR (edit under your own checkout/worktree,
never the primary):

- **`active` (create).** **Append** the campaign row in the `active` state, pinned to the Step-2
  milestone number:

  ```
  | <Campaign name> | #<MILESTONE_NUMBER> | active |
  ```

- **`done` (complete).** **Flip** the existing row's `State` cell from `active` to `done` (leave
  the milestone pin) — see the [done path](#the-symmetric-lifecycle--active-create-and-done-complete)
  for the paired milestone close.

Open the PR against the wave's tracking issue so it closes on merge:

```bash
git switch -c "<prefix>/campaign-<wave-label>-<active|done>" origin/$PIPELINE_BASE_REF   # branch off the fresh configured base ref in your worktree
# edit $PIPELINE_CAMPAIGN_ROADMAP_PATH's ## Campaigns table, commit $PIPELINE_CAMPAIGN_ROADMAP_PATH by explicit path
gh api -X POST "repos/$REPO/pulls" \
  -f "title=roadmap: record <Campaign name> campaign (<active|done>)" \
  -f "head=<branch>" -f "base=$PIPELINE_BASE_REF" \
  -f "body=Records the <Campaign name> audit wave (\`$WAVE_LABEL\`) as a bounded campaign — milestone #<MILESTONE_NUMBER>, $PIPELINE_CAMPAIGN_PRIORITY, configured-campaign-lane drained. Designated-approver approval trace verified. Fixes #<tracking-issue>."
```

The PR keeps `repository roadmap validation gate` green **by construction**: creating a campaign adds a row that
**claims** the (open) milestone Step 2 provisioned — satisfying I3 (no unclaimed open milestone) —
and pins it by number (I1). The row-PR is the seam that keeps $PIPELINE_CAMPAIGN_ROADMAP_PATH and the milestone
projection in sync; do not stamp the milestone (Step 2) without the paired row, or the guard fails
on an unclaimed open milestone.

This PR goes through the normal review gate like any other — the skill **stops at PR-open**; it
does not self-review or merge.

---

## The symmetric lifecycle — `active` (create) and `done` (complete)

A campaign has a **two-state** lifecycle (there is no `queued` — unlike an arc, a campaign is not
sequenced ahead; it opens `active` when the designated approver starts it and ends `done`). Both transitions
run the **same gate** (Step 1), so completing a campaign is exactly as guarded as starting one:

- **`active` — create.** Steps 1 → 2 → 3 → 4 as above: gate, provision + stamp the milestone,
  configured-priority re-price the wave, open the Campaigns-row PR adding the `active` row.

- **`done` — complete.** When the campaign's milestone is fully drained, complete it:
  1. **Gate** (Step 1) — the same approval-trace check.
  2. **Close the milestone** — the operational projection of a finished campaign:

     ```bash
     gh api -X PATCH "repos/$REPO/milestones/$MILESTONE_NUMBER" -f state=closed >/dev/null
     ```
  3. **Flip the ROADMAP row to `done`** in a Campaigns-row PR (Step 4, `done` variant) — the row's
     `State` cell goes `active → done`, keeping the milestone pin.

  Closing the milestone and flipping the row are **paired**: `repository roadmap validation gate`'s I3 only requires
  *open* milestones to be claimed, so a `done` row pinned to a now-closed milestone is in sync. Do
  the two together in the same PR-and-close so the roadmap never shows a `done` row over an open
  milestone (or a closed milestone under an `active` row).

---

## Worked example — the Mentor Audit campaign (`mentor-audit`, milestone #27)

The **Mentor Audit** campaign is the validation case this skill walks end to end: a security &
architecture audit wave (the contribution-score race, per-actor rate limiting, ops runbooks,
`SECURITY.md`, …) filed as a cluster of `report` issues sharing the `mentor-audit` label.

**Recording it (`active`).** Given `WAVE_LABEL=mentor-audit`:

1. **Gate.** `campaign verify-trace mentor-audit --approver "$APPROVER"` — passes only if a
   designated approver-authored `campaign-approve: mentor-audit · <ts>` comment exists on a `mentor-audit`
   issue. No trace ⇒ refuse, the wave stays un-recorded.
2. **Milestone.** Attach to the curated `Mentor Audit campaign` milestone (`#27`) — a dedicated
   campaign milestone, not a active delivery stream's — and stamp `#27` on every `mentor-audit` issue.
3. **configured-priority re-price.** Every open `mentor-audit` issue → `$PIPELINE_CAMPAIGN_PRIORITY`, so the wave drains via the configured campaign
   lane alongside the active **current delivery stream** arc.
4. **ROADMAP row PR.** Append `| Mentor Audit | #27 | active |` to `## Campaigns`, opened as a PR
   that closes its tracking issue.

**Completing it (`done`).** Once `#27` is fully drained: run the gate again, close milestone `#27`
(`PATCH .../milestones/27 state=closed`), and open the Campaigns-row PR flipping the row to
`| Mentor Audit | #27 | done |`. The closed milestone under a `done` row keeps `repository roadmap validation gate`
in sync.

This is the campaign the $PIPELINE_CAMPAIGN_ROADMAP_PATH `## Campaigns` section already carries as its first row — the
skill's job is to make recording the *next* such wave the same one guarded ritual.

---

## The ritual is done — stop at PR-open

The `campaign` ritual ends when the Campaigns-row PR is open (`active`) or open-and-milestone-closed
(`done`). There is **no self-review, no merge** — the ROADMAP PR goes through the normal review
gate like any other change. If any step failed — the gate refused, the milestone couldn't be
resolved, an issue wouldn't re-price — **stop at the failure and surface it**; never open a
"recorded" ROADMAP row over a wave whose approval trace didn't verify. The gate-before-mutation
ordering is what keeps an un-approved wave from ever reaching the roadmap.
