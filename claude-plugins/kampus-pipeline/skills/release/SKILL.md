---
name: release
description: >-
  The human release act made one guarded command — release a dark-shipped feature end to end without ever touching the configured release-provider dashboard. Given a flag key, run the guarded release ritual: pre-flight the flag's effective serving via release adapter and confirm it is currently dark, refuse the flip when the flag's user-facing slice is unreachable via repository reachability checker (no consuming UI / no registered journey e2e, the repository reachability invariant), flip it live through the release adapter's canonical percentage-rollout lever (dry-run → --execute), post-flight verify the flip took (dark → live), clear $PIPELINE_RELEASE_QUEUE_LABEL on the linked issue, and emit a human-readable release note. Supports `/release <flag-key> --percent <n>` for a ramped release. HUMAN-ONLY — an autonomous agent invoking it is hard-refused, the same enforcement shape as ship-it refusing to self-merge a control-plane PR (the repository control-plane boundary). Trigger on "release <flag-key>", "flip <flag-key> live", "release the dark feature", "/release". This is the human half of the agents-deploy / humans-release boundary (the repository agents-deploy / humans-release decision); the deploy is the agent's autonomous merge, the flip is yours.
---

# release

## Repository-owned integration contract

This optional workflow keeps the complete guarded release ritual, but it has no default provider. Before a human runs it, the consumer repository must enable it in `.pipeline/optional-workflow-policy.json` and supply: `$PIPELINE_RELEASE_ADAPTER_DIR`, `$PIPELINE_RELEASE_ADAPTER_COMMAND`, `$PIPELINE_RELEASE_REACHABILITY_COMMAND`, the target environment and credential-resolution procedure, `$PIPELINE_RELEASE_QUEUE_LABEL`, `$PIPELINE_RELEASE_APPLICATION_PATH`, `$PIPELINE_BASE_REF`, and the release-note / issue-link convention. The adapter must expose an effective-serving read, a dry-run, an explicit execute operation, and a post-flight read.

Do not infer a provider, credentials, flag representation, queue label, application path, or release authority from the examples below. If the adapter or a required value is absent, refuse before a mutation. The human-only control-plane guard, reachability gate, dry-run → execute sequence, post-flight verification, and verify-before-record ordering are retained exactly.

You are the human at the release lever. A feature was **deployed dark** — merged to `$PIPELINE_BASE_REF`
and live in production behind a default-off feature-flag service flag, contained and invisible to users
until someone deliberately flips it (ADR
the repository agents-deploy / humans-release decision:
*agents deploy, humans release*). This skill is that flip, made **one guarded command** so the
release act is a reviewable, verified ritual instead of an untraceable click in the configured release provider
dashboard. You run the steps below end to end — pre-flight, the reachability gate (refuse the flip
if the flag's user-facing slice is unbuilt, the repository reachability invariant), flip, post-flight verify, clear the queue
label, emit the release note — and you never open the dashboard.

The tool under every read and write here is **`repository release adapter`** — the human-operated feature-flag service
CLI (`$PIPELINE_RELEASE_ADAPTER_DIR`, the
the repository feature-flag integration decision).
It models the release the way it is actually performed: as a **no-match percentage split** (a
conditions-empty rule serving `on` to N% of traffic), **never** a `provider-wide default-state setting` flip. Read
its repository-owned adapter documentation for the
full command surface; this skill is the *release ritual* that composes those commands, not a
second copy of them.

## HUMAN-ONLY — an autonomous agent MUST hard-refuse (guard 0)

**Release authority is the human flip.** This skill performs the one act the repository agents-deploy / humans-release decision §1 reserves
to a human: making a dark feature visible to users. An **autonomous agent** reaching for
`/release` is a control-plane boundary violation, not a convenience — exactly as an agent
reaching to self-merge a control-plane PR is (ADR
the repository control-plane boundary).
So the first thing this skill does, **before any read, flip, or label write**, is refuse when
the caller is not a human at a keyboard:

- **If you are an autonomous agent** (a pipeline subagent, a Workflow task, any non-interactive
  invocation), **hard-refuse and stop.** Do not pre-flight, do not dry-run, do not flip. Emit
  the refusal and halt — the identical enforcement shape as `ship-it` Step 0 refusing to
  auto-merge a `.claude`/`.github`/gate-critical PR: a structural boundary the pipeline never
  routes around, never a soft warning it proceeds past.

  > **release: REFUSED — human-only.** `/release` performs the human release act (the repository agents-deploy / humans-release decision §1:
  > agents deploy, humans release). An autonomous agent flipping a flag live is a control-plane
  > boundary violation (the repository control-plane boundary), the same class as self-merging a control-plane PR. The flag
  > stays dark. A human runs this command; the agent's boundary ended at the dark deploy.

- **If you are Claude Code driving an interactive human session** and a human typed `/release`
  (or asked you to run it), you are their hands at the lever — proceed through the ritual. The
  human is the release authority; you execute their explicit release on their behalf. This is
  the *only* sanctioned path past this guard.

The refusal is **fail-closed**: absent positive evidence that a human is driving this
invocation, refuse. An unattended drain, a spawned coder, a scheduled job — none of them are the
human this boundary reserves the act for. This guard is the skill's load-bearing invariant, not
advice: a `/release` that flips without a human at the keyboard has dismantled the agents-deploy / humans-release
boundary the whole dark-ship discipline rests on.

---

## Preconditions — credentials + the flag key

You need two things before the ritual:

1. **configured release provider credentials resolvable by release adapter.** `release adapter` reads `$PIPELINE_RELEASE_API_TOKEN` +
   `$PIPELINE_RELEASE_ACCOUNT_ID` from the environment, or the macOS Keychain once you've run
   `release adapter auth login` (the repository credential-resolution record — the keychain-backed credential store, so the ritual never opens
   with "export your API token"). Confirm they resolve and actually authenticate before you
   touch a flag:

   ```bash
   cd $PIPELINE_RELEASE_ADAPTER_DIR
   "${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" auth status   # reports where each credential resolves from and whether it authenticates
   ```

   If `auth status` reports the effective resolution does **not** authenticate, run
   `"${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" auth login` (prompts for the token + account id, validates them against an
   authenticated read **before** persisting, stores both in the Keychain) and re-check. Do not
   proceed on unauthenticated credentials — every step below would fail mid-ritual.

2. **The flag key + target env.** The command is `/release <flag-key>` — a kebab-case feature-flag service
   key (`<product>-<feature>-<purpose>`, e.g. `example-feature-notification`). The release target is the
   **`prod` env** by default (the release act is a production flip); pass `--env <env>`
   explicitly only to release into a non-prod env. Resolve them once:

   ```bash
   FLAG_KEY="<the kebab-case flag key>"
   ENV="prod"   # override only with an explicit --env
   ```

Resolve `$REPO` the same way the rest of the pipeline does (it is repo-agnostic; the pipeline repository-resolution contract):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

All GitHub reads/writes below go through **`gh api` REST** — never GraphQL (the org's
configured planning-board integration errors GraphQL issue/PR queries, the standing pipeline constraint).

---

## Step 1 — Pre-flight: read the effective serving, confirm it is dark

Read the flag's **effective serving** — what the env *actually serves* today, resolved through
rules → no-match split → default — and confirm the flag is currently **dark** before you flip
anything. `flag get` reports it in the canonical form (`off (default)` for an unreleased flag,
`on@100% (split)` for a released one, `on@N% (ramping)` for a partial):

```bash
cd $PIPELINE_RELEASE_ADAPTER_DIR
"${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" flag get "$FLAG_KEY" --env "$ENV"
```

- **Currently `off (default)` (dark) →** this is a release you can perform: proceed to Step 2.
- **Already `on@100% (split)` (fully live) →** there is nothing to release. **Stop** and report
  it — re-flipping a live flag is a no-op, and the queue label (Step 4) was almost certainly
  already cleared. This keeps the ritual **idempotent**: `/release` on an already-live flag is a
  clean no-op, not a double-flip.
- **Already `on@N% (ramping)` at a *lower* percent than you intend →** this is a **ramp-up**, not
  a first release; continue to Step 2 with the higher `--percent` (the ramp form below). Flipping
  to a lower or equal percent is a no-op — stop and report.
- **`FlagEnvNotFound` / not-found →** the key or env is wrong; fix the input and re-read. Do not
  proceed against a flag release adapter can't resolve.

Also resolve the **linked issue** now — you'll need it for Steps 4 and 5, and confirming it
exists up front means the ritual never flips a flag it can't then dequeue. The dark ship was
queued by `ship-it` as `$PIPELINE_RELEASE_QUEUE_LABEL` on the merged PR's linked issue, and the flag
key rides the PR body's `Flag: <key>` line (ship-it Step 5b). Find the awaiting-release issue
whose closing PR dark-shipped **this** flag key:

```bash
# candidate issues on the release queue (the label persists on the closed, linked issue; see the repository release-queue contract)
for ISSUE in $(gh api "repos/$REPO/issues?state=all&labels=$PIPELINE_RELEASE_QUEUE_LABEL&per_page=100" \
    --jq '.[] | select(.pull_request | not) | .number'); do
  # find the PR(s) that closed this issue and check each body for a `Flag: <key>` line naming THIS key
  # (the grammar write-code Step 5 writes and ship-it Step 5b reads)
  for PR in $(gh api "repos/$REPO/issues/$ISSUE/timeline?per_page=100" \
      --jq '.[] | select(.event=="cross-referenced" or .event=="closed")
                | .source.issue.number? // empty' 2>/dev/null | sort -u); do
    body=$(gh api "repos/$REPO/pulls/$PR" --jq '.body // ""' 2>/dev/null)
    printf '%s' "$body" \
      | grep -Eiq "^[[:space:]]*(#{1,6}[[:space:]]*)?\**[[:space:]]*flag([[:space:]]*key)?:[[:space:]]*\**[[:space:]]*${FLAG_KEY}([[:space:]]|$)" \
      && echo "match: issue #$ISSUE ← PR #$PR declares Flag: $FLAG_KEY"
  done
done
# LINKED_ISSUE is the awaiting-release issue whose closing PR body carried `Flag: $FLAG_KEY`.
LINKED_ISSUE="<that issue number>"
```

If no `$PIPELINE_RELEASE_QUEUE_LABEL` issue names this flag, or the match is ambiguous, **ask the human
to confirm the issue number** (or confirm there is no queue entry to clear) rather than guessing —
a wrong dequeue clears another feature's queue entry. Never silently skip Step 4.

---

## Step 1.5 — Reachability gate: refuse the flip unless the flag's UI slice is reachable (the repository reachability invariant)

Between resolving the flag (Step 1) and flipping it (Step 2), assert the flag's vertical is
**reachable**: a user-facing flag graduates to 100% (or ramps) only once a **consuming UI** and a
**registered journey e2e** exist for its key. This closes the "graduate a flag nothing consumes"
gap — reactions reached 100% in prod with **zero `.tsx` consuming `the configured feature-flag constant`**, caught
only when a human happened to notice (ADR
the repository reachability invariant,
the repository reachability record). The gate converts "someone happens
to notice an unreachable feature" into "the release path structurally won't flip one."

The check is the **one shared `reachability checker` contract** `plan-epic` also keys off — never a
second, drifting notion of "reachable" (the repository reachability invariant §1). Given `$FLAG_KEY` it asserts both a
consuming `$PIPELINE_RELEASE_APPLICATION_PATH/src/**/*.tsx` reference to the flag-key constant and a `@journey:$FLAG_KEY`-tagged
spec under `$PIPELINE_RELEASE_APPLICATION_PATH/tests/e2e/`, and **fails closed** (non-zero exit) naming exactly what's
missing. Run it for the resolved key **before the dry-run flip**:

```bash
REACH="${PIPELINE_RELEASE_REACHABILITY_COMMAND:?set to the repository fail-closed reachability checker}"

# HARD-REFUSE the flip on a non-zero exit — the report (on stderr) names which assertion failed
# (no consuming UI / no journey e2e for $FLAG_KEY, or an unknown/unclassified flag). The flag
# stays dark; do NOT proceed to Step 2.
if ! $REACH "$FLAG_KEY"; then
  cat >&2 <<EOF
release: REFUSED — reachability gate. \`$FLAG_KEY\` is UNREACHABLE (see the reachability checker
report above): its vertical's user-facing slice is unbuilt, so it must not graduate to 100%
(the repository reachability invariant, the repository reachability record). The flag stays DARK. Build + wire the missing slice — the consuming
.tsx and/or the @journey:$FLAG_KEY-tagged e2e the report named — then re-run /release. If this
flag is UI-less by design (an infra/containment flag), mark it @reachability-exempt: <reason>
at its $PIPELINE_RELEASE_APPLICATION_PATH/src/flags/keys.ts definition; the gate then passes it.
EOF
  exit 1
fi
```

- **Non-zero exit → hard-refuse the flip.** This is the identical fail-closed refusal shape as
  the skill's guard-0 human-only refusal and the Step-3 post-flight verify-before-record stop —
  a structural boundary the ritual never routes around, never a soft warning it proceeds past.
  The flag stays dark; the human builds the missing user-facing slice first, then re-runs
  `/release`.
- **Exit 0 → reachable *or* exempt → proceed to Step 2.** A legitimately UI-less
  infra/containment flag (e.g. `example-edge-cache-control`, `EXAMPLE_EDGE_CACHE_CONTROL` — the repository's explicit-exemption rule) passes
  here **because it carries a `@reachability-exempt: <reason>` marker at its `keys.ts`
  definition** (the repository reachability invariant §3). The refusal targets unreachable **user-facing** flags only; it
  never blocks a stated-exempt infra flag.

This gate is a check **the human's `/release` run** performs — it slots *after* guard 0, so a
human is already at the lever (the repository agents-deploy / humans-release decision); it adds a precondition to the flip, it does **not** make
`/release` autonomous. `reachability checker` proves *presence* (a consuming reference + a
registered e2e exist), not correctness — a stub consumer or an empty journey spec passes; the gate
makes the zero-UI graduation unrepresentable, not the shallow-UI one.

---

## Step 2 — Flip: the 100%-no-match-split lever, dry-run then `--execute`

The flip is a `release adapter flag set` write on the **canonical 100%-no-match-split form** (`on` ≡
`--percent 100`) — the *same* lever the release is actually performed with, **never** a
`provider-wide default-state setting` write (`provider-wide default-state setting` stays at its create-time safe value forever; only
the `off` kill switch touches it, and this skill never issues `off`).

**Always dry-run first.** `flag set` is **dry-run by default**: it reads current state, prints
the `current → target` diff, and writes **nothing** unless you add `--execute`. Read the diff and
confirm it flips *this* flag in *this* env from the dark state you saw in Step 1 to the intended
live state:

```bash
cd $PIPELINE_RELEASE_ADAPTER_DIR
# Full release (100% — the default release act):
"${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" flag set "$FLAG_KEY" on --env "$ENV"                 # DRY-RUN: prints current → target, writes nothing

# Ramped release (--percent N — serve `on` to N% of traffic; the remainder falls to the safe default):
"${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" flag set "$FLAG_KEY" --percent "$N" --env "$ENV"     # DRY-RUN
```

Once the dry-run diff is exactly the release you intend, **execute it** by re-running the same
command with `--execute`:

```bash
"${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" flag set "$FLAG_KEY" on --env "$ENV" --execute            # APPLY the full release
# or, for a ramp:
"${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" flag set "$FLAG_KEY" --percent "$N" --env "$ENV" --execute
```

**`--percent <n>` — the ramped-release form.** `/release <flag-key> --percent 50` runs the
identical ritual but flips to a **no-match split serving `on` to N%** of traffic instead of 100%,
using the release adapter's ramp lever (the repository ramp-release record). Everything else is unchanged: pre-flight read, dry-run →
`--execute`, post-flight verify, clear the label, release note. A ramp is still a release — the
feature becomes visible to N% of users — so it clears the queue label and emits a release note
the same as a full flip, with the percent recorded in the note. (A later ramp-up to a higher
percent re-runs `/release <flag-key> --percent <higher>`; the label is already cleared, so
Step 4 is a no-op on the ramp-up, which is correct.)

**The two-step is the safety.** The dry-run makes an accidental prod release *unrepresentable* —
the mutation happens only under the explicit `--execute`, mirroring `orphan-sweep`. Never skip
straight to `--execute`: read the diff, then apply.

---

## Step 3 — Post-flight: re-read effective serving, confirm the flip took (dark → live)

A flip you didn't verify is a flip you can't trust. Re-read the **effective serving** and confirm
it now reports the live state — the dark → live transition actually landed:

```bash
cd $PIPELINE_RELEASE_ADAPTER_DIR
"${PIPELINE_RELEASE_ADAPTER_COMMAND:?set to the repository release-adapter command}" flag get "$FLAG_KEY" --env "$ENV"   # expect: on@100% (split)  — or  on@N% (ramping) for a ramp
```

Assert the transition:

- A full release must now read **`on@100% (split)`** (was `off (default)` in Step 1).
- A `--percent N` ramp must now read **`on@N% (ramping)`** at the N you flipped to.

If the post-flight read does **not** show the expected live state, the release **did not take** —
do **not** clear the queue label or emit a "released" note. Surface the discrepancy (what you
expected vs. what `flag get` reports), and stop so a human can investigate; a half-applied flip
left recorded as released is worse than an obvious failure. Optionally cross-check by hitting the
flag's evaluate path if one is available, but the effective-serving re-read is the authoritative
confirmation release adapter gives you.

Only once the post-flight read confirms **dark → live** do you proceed to Steps 4 and 5.

---

## Step 4 — Clear the release-queue label on the linked issue

The feature is now live, so it is no longer *awaiting* release — clear `$PIPELINE_RELEASE_QUEUE_LABEL`
from the linked issue you resolved in Step 1. This is the queue's **consume** step (the repository release-queue record): an
infra-admin lists the queue with one filter, releases, then clears the label. `/release` does the
clear for you so the label doesn't rot (8 stale labels sat on already-released issues before being
hand-cleared the night this skill was proposed):

```bash
# remove the release-queue label from the (closed) linked issue — the consume half of the repository release-queue record
gh api -X DELETE "repos/$REPO/issues/$LINKED_ISSUE/labels/$PIPELINE_RELEASE_QUEUE_LABEL"
```

The label lives on a **closed** issue (the dark ship's PR closed it on merge); removing a label
from a closed issue is fine and expected — the label is a post-merge *release* state, orthogonal
to the `status:*` pickability spine. If the issue no longer carries the label (a prior partial
run, or ship-it never queued it), the delete is a harmless no-op — the ritual stays idempotent.

---

## Step 5 — Emit the human-readable release note

The queue label is a machine state; a **release note** is the human-readable record of what just
went live — the artifact demanded by the repository release-note record (dark-ship flags need a readable release note, not
just the awaiting-release queue). Emit it as the final act of the ritual: a short, glanceable
note naming the feature, the flag, the flip, and the linked issue. Post it as a comment on the
linked issue so it is durable and discoverable next to the work it releases (and surface the same
text to the human running the command):

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BODY="$(cat <<EOF
## Released 🚀 — \`$FLAG_KEY\`

- **Flag:** \`$FLAG_KEY\` (env: \`$ENV\`)
- **Serving:** dark (\`off (default)\`) → live (\`$SERVING_NOW\`)
- **Released:** $NOW by <human releaser>
- **Closes the release queue for:** #$LINKED_ISSUE

The feature is now visible to users. The dark deploy (agent-merged) is now a release (human flip)
— the the repository agents-deploy / humans-release decision boundary, closed.
EOF
)"
gh api "repos/$REPO/issues/$LINKED_ISSUE/comments" -f body="$BODY"
```

`$SERVING_NOW` is the exact effective-serving string Step 3 confirmed (`on@100% (split)` or
`on@N% (ramping)`), so the note records the true post-flip state, not an assumed one. Keep the
note scannable — feature, flag, the dark → live transition, who released it, and the issue it
dequeues. This is the record a later `what-shipped` readout and any human auditing the release
queue reads to answer "what went live, when, and by whose flip."

---

## The ritual is done — no gate, no merge, nothing further

`/release` ends at the release note. There is **no PR, no review gate, no merge** — this is not a
code change, it is a runtime flip of production serving state performed by a human. Do not queue
anything, do not spawn a follow-up, do not re-flip. The five steps — pre-flight → flip →
post-flight verify → clear the label → release note — are the whole act.

If any step failed (unauthenticated credentials, a not-found flag, a post-flight read that didn't
confirm the flip), **stop at the failure and surface it** — never proceed to clear the label or
emit a "released" note on an unverified flip. A release that half-applied and was recorded as
complete is the failure mode this ritual's verify-before-record ordering exists to prevent.
