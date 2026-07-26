---
name: what-shipped
description: The stakeholder's on-demand "what did we ship" readout. Gather merged work over a window (git log plus GitHub metadata), join each PR to optional issue/milestone/type data, use repository category metadata when available, resolve live-vs-dark release state only through a configured release-state adapter, then invoke `pipeline-cli ship-digest derive` and present the grouped digest. Trigger on "what shipped", "what did we ship", "ship digest", "what's live", "what's still dark", "/what-shipped".
---

# what-shipped

## Repository-owned policy boundary

This workflow is part of the default generic payload and `pipeline init` links it into
`.claude/skills`. It is read-only: it gathers Git, GitHub, and optional release-state data.
It never changes a release, flag, issue, pull request, or deployment. Read
`.pipeline/agent-policy.json` and repository documentation before using an external adapter;
when no release-state adapter is configured, report merged work without claiming live state.

You are the **gather-and-present** layer of the stakeholder-facing ship digest. The
pure projection core — grouping merged work product/infra → milestone → type, and rendering the
live/dark axis — already lives in `pipeline-cli ship-digest` (`packages/pipeline-cli/src/tools/ship-digest/`,
That core is **deliberately IO-free**: it consumes a pre-gathered entries JSON and renders. This
skill does the IO the core refuses to — read git, read GitHub metadata, and optionally read a
configured release-state adapter — assemble the entries JSON, hand it to the tool, and show the
stakeholder the result.

**Pull-first, on demand.** A stakeholder runs `/what-shipped` when they want the readout; there is no
cron and no auto-posted Discussion (an explicit non-goal of this surface — a push mode, if ever
built, adds a `.github/workflows/` cron, which may be protected by repository policy, not
part of this skill).

**You gather and present; you never flip a flag.** The live/dark axis is read from a configured
release-state adapter when one exists, never written. This skill reads authoritative state to
*report* it; it does not automate release.

## GitHub metadata access

Use the GitHub interface the repository supports. `gh api` REST is a portable default because it
works without requiring a GraphQL integration. Resolve the target repo once, up front (this skill
is repo-agnostic — every call
targets `$REPO`), per the shared contract's target-repo rule
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## Resolve the `ship-digest` command once — in-repo-first, published-fallback

Prefer the on-disk consolidated `packages/pipeline-cli/src/bin.ts` when it exists (repository-local:
no network, no published-artifact dependency); otherwise invoke the local toolkit command supplied
by `pipeline init`. Build it once:

```bash
if [ -f packages/pipeline-cli/src/bin.ts ]; then
  DIGEST="node packages/pipeline-cli/src/bin.ts ship-digest"   # repository-local consolidated bin
else
  # Foreign install: use the pinned local toolkit command installed by pipeline init.
  DIGEST=".pipeline/toolkit/bin/pipeline cli ship-digest"
fi
```

---

## Step 0 — Fix the window

Default the window to a recent, glanceable span — the last **7 days** unless the requester names
another (`/what-shipped since 2026-06-01`, `/what-shipped last 30 days`). The window is two ISO
dates the digest heading reports over:

```bash
SINCE="${SINCE:-$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)}"
UNTIL="${UNTIL:-$(date -u +%Y-%m-%d)}"
echo "window: $SINCE → $UNTIL"
```

`ship-digest derive` needs `--since` (required) and optional `--until` (defaults to today), so
`$SINCE`/`$UNTIL` flow straight through at Step 4.

---

## Step 1 — Gather the merged PRs in the window

Get the PRs merged into `main` since `$SINCE`. The **merged-PR number is the primary key** of
every entry (`ShipEntry.pr` is always present); everything else is joined onto it.

Read merged PRs via `gh api` REST (never GraphQL). The `search/issues` endpoint filters on
`merged:` directly:

```bash
# merged PRs in the window — REST search, never GraphQL. `is:merged` + `merged:$SINCE..$UNTIL`.
gh api -X GET search/issues \
  -f q="repo:$REPO is:pr is:merged merged:$SINCE..$UNTIL" \
  -f per_page=100 --jq '.items[] | .number'
```

If you prefer to anchor on the merge commits rather than trust the search index, cross-check with
`git log --since "$SINCE" --until "$UNTIL" --merges --first-parent <configured-base-branch>` and extract the
`#NNN` from each squash/merge subject — the two should agree; the REST search is authoritative for
the metadata join below.

For each merged PR number, read the fields the entry needs:

```bash
# per merged PR: title, optional repository category metadata, and the
# linked issue via the `Fixes #N` / `Closes #N` in the PR body.
gh api "repos/$REPO/pulls/$PR" --jq '{title: .title, body: .body, labels: [.labels[].name]}'
```

- **`title`** → the entry's `title` (prefer the linked-issue title once resolved in Step 2).
- **Repository category label** → the entry's optional **`area`**. Use it only when the
  repository documents its meaning; otherwise leave `area` unset and let the Step-2 join supply
  `joinedArea` when available.

---

## Step 2 — Join each PR → its issue → milestone / type (the fallback section source)

Parse the PR body for its `Fixes #N` / `Closes #N` / `Resolves #N` backlink to find the linked
issue, then read that issue's metadata:

```bash
# the linked issue's title, milestone, and optional type label — the entry's title (preferred), milestone, and type.
gh api "repos/$REPO/issues/$ISSUE" \
  --jq '{title: .title, milestone: (.milestone.title // null), type: ([.labels[].name | select(startswith("type:")) | sub("^type:";"")] | first // null)}'
```

Populate each entry from the join:

- **`issue`** — the linked issue number (omit when the PR closes no issue).
- **`title`** — prefer the **closed-issue title**; fall back to the PR title when there is no link.
- **`milestone`** — the issue's milestone title, or omit (→ `Uncategorized`).
- **`type`** — a repository-defined type value when one exists, or omit (→ `Uncategorized`).
- **`joinedArea`** — the **fallback** category recovered from the linked issue or milestone when
  the PR carried no category metadata. The core prefers the PR `area` and only consults
  `joinedArea` when `area` is absent (`resolveSection`).

A PR that closes no issue is not dropped — carry it with just `pr` + `title` (+ `area` if known);
the core surfaces it under a generic uncategorized section, flagged, never dropped.

---

## Step 3 — Resolve each entry's live-vs-dark release state (authoritative adapter read)

This is the axis that answers **"what is actually LIVE to users,"** not just what merged. When
the repository has a release-state adapter, state is sourced from that adapter's authoritative
read — **not** from repository-declared flag defaults or a workflow label, because only an
authoritative read reflects an out-of-band release action.

Read the live flag × environment matrix once through the repository's configured release-state
adapter. The adapter must report each flag's **effective serving** per environment; credentials
come from the ambient environment, never source. Do not infer live state from a flag declaration
when the adapter reports a different effective value:

```bash
# The repository owns this command and its credentials. Do not invent a fallback platform.
"${RELEASE_STATE_COMMAND:?configure a read-only release-state adapter command}" flag list
```

Assign each merged entry a **`releaseState`** — one of `live` / `awaiting-release` / `dark` /
`unknown` (`RELEASE_STATE_ORDER`), by this rule:

- **Flag-gated feature:** look up that flag's **effective serving** (`SERVES`) for the production
  environment in the `flag list` output.
  - **`on@100% (split)` or `on (default)`** → `live` (a split-released flag is live even though its
    declaration may remain off — never read a declaration as the release state).
  - **`on@N% (ramping)`, 0 < N < 100** → `live` (partially released — note the ramp share).
  - **`off (default)` (no split serving, not yet released)** → `dark` (merged behind a default-off
    flag; live only once an authorized releaser enables it).
  - queued for release but the flip is imminent / staged → `awaiting-release` (use when the
    release-handoff signal says so and the flag is not yet on).
- **Non-flag-gated work** (internal / refactor / infrastructure / docs, with no flag to read):
  **merged is live** → `live`, unless repository policy says otherwise.
- **No resolvable flag/release state** — a feature that *should* be flag-gated but you cannot map to
  a flag, the adapter is absent, or the read is inconclusive → **`unknown`**. Never silently treat it as `live`;
  the core's `resolveReleaseState` default is `unknown`, and the acceptance criterion is explicit
  that unmapped work surfaces as unknown).

Map a merged feature to its flag key through the repository's documented feature-flag location and
adapter contract — the flag key is the join between "this merged feature" and the adapter row.
When that map is ambiguous, prefer `unknown` over a guess.

---

## Step 4 — Assemble the entries JSON and invoke `ship-digest derive`

Write the gathered entries to a JSON array — the exact shape `ship-digest derive` decodes at its
trust boundary (`packages/pipeline-cli/src/tools/ship-digest/command.ts`, validated by the
repository's configured schema checks). Each entry:

```jsonc
[
  {
    "pr": 1574,                      // required — the merged-PR number (primary backlink)
    "issue": 1572,                   // optional — the closed issue, when linked
    "title": "isolate the shipper dispatch in drive-issue.js to a worktree",
    "type": "chore",                 // optional — repository type value; absent ⇒ Uncategorized
    "milestone": "Pipeline hardening", // optional — issue milestone; absent ⇒ Uncategorized
    "area": "infra",                 // optional — repository category signal (preferred, join-free)
    "joinedArea": "infra",           // optional — join fallback; consulted only when area absent
    "releaseState": "live"           // optional — live/awaiting-release/dark/unknown; absent ⇒ unknown
  }
]
```

Write it to a scratch file (never a repo path — this is throwaway gather output, not a committed
artifact), then invoke:

```bash
ENTRIES="$(mktemp -t what-shipped-entries.XXXXXX.json)"
# … write the gathered array to "$ENTRIES" …
$DIGEST derive --entries "$ENTRIES" --since "$SINCE" --until "$UNTIL"
```

`ship-digest derive` decodes the entries, runs the pure `deriveShipDigest` core, and prints the
grouped digest (category → milestone → type, with the per-entry live/dark annotation and the
"currently dark — awaiting your release" callout) to stdout. A malformed entries file is a typed
`EntriesReadError` (non-zero exit), not a crash — fix the JSON and re-run.

---

## Step 5 — Present the digest to the stakeholder

Show the rendered markdown digest directly. It already carries both axes in one readout:

- **What merged** — grouped by available repository category → `### <milestone>` → `#### <Type>`, each
  merged item a `- <title> (#PR)` line.
- **What is live vs dark** — the inline release-state annotation per entry, plus the distinct
  **"currently dark — awaiting your release"** section listing the not-yet-live work (`dark` +
  `awaiting-release`). This is the stakeholder's release-action list: features that merged but
  wait on an authorized release action to reach users.

Add a one-line lead-in naming the window (`Since <SINCE>: N merged, M live, K still dark`) so the
readout is glanceable at the top, then the digest. If the dark section is populated, call it out —
that is the cue to use the repository's authorized release process, not an instruction to invoke a
specific platform command.

Do **not** commit anything, open a PR, or post a Discussion — this is a read-only pull surface. The
only writes this skill makes are to the scratch entries file; clean it up when done (`rm -f "$ENTRIES"`).
