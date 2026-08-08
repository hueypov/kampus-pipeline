# pipeline-cli tools — the per-tool reference

The internal per-tool reference for `pipeline-cli`. The package
[README](./README.md) is the consumer front page; this doc is for people working in the
example-repo monorepo who need to know what a given tool does, how it is shaped, and how to add
a new one. It carries repo-internal context — issue and ADR references, the pipeline
vocabulary — that a public reader has no frame for.

The commands here run against the in-repo entry (`node packages/pipeline-cli/src/bin.ts
<tool>`), the form a monorepo contributor uses. An npm consumer runs the installed binary
(`pipeline-cli <tool>`) instead; see the README.

## Discovering the tools — `pipeline-cli commands` (the rot-proof index)

The authoritative, always-current list is **generated from the registry**, so it can't
drift the way a hand-maintained list does (the failure this doc's old Phase-1 framing
was itself an instance of — the originating work item). Run it on demand:

```bash
# one line per registered tool: name · one-line purpose (the discovery map — the originating work item)
node packages/pipeline-cli/src/bin.ts commands compact

# CI gate: red if any registered tool ships without a one-line description (fail-closed)
node packages/pipeline-cli/src/bin.ts commands check
```

`commands compact` mirrors `decisions-index compact`: it derives purely from each `Command`'s own `name` + `description`,
so a newly-registered tool appears automatically. The per-tool `###` sections below are a
**curated subset with usage detail** — for the complete list, run `commands compact`.

## Shape

Per the repo's mechanical-tooling idiom (`decisions-index` / `epic-ledger` /
`leak-guard`): a pure, unit-tested core + a thin Effect CLI bin.

- `src/registry.ts` — **the extension seam.** `registeredTools` is the array of
  `effect/unstable/cli` `Command`s the router exposes. A Phase-2 child folds its
  tool in by appending one `Command` here — and nothing else. The router and bin
  consume this array opaquely.
- `src/router.ts` — the **pure router core.** `dispatch(registry, argv)` resolves
  the first argv token to a registered tool (`Ok({ tool, rest })`), or fails with
  a clear `UnknownToolError` (unknown token) / `NoToolError` (no token). It owns
  no Effect runtime, so the dispatch contract is unit-testable directly (the test-tier taxonomy
  T0/T1) — the mirror of the runtime dispatch `Command.withSubcommands` does.
- `src/version.ts` — the `version` tracer tool, a normal registered tool.
- `src/bin.ts` — the `effect/unstable/cli` bin: `Command.withSubcommands(registeredTools)`,
  run via `NodeRuntime.runMain`.

## The extension seam

A later child registers its moved tool **without touching the router core**:

```ts
// src/registry.ts
import {myToolCommand} from "./my-tool.ts";
export const registeredTools: ReadonlyArray<RegisteredTool> = [versionCommand, myToolCommand];
```

That single append is the entire registration step. `router.ts` and `bin.ts`
never change — the router is closed for modification, the registry is open for
extension.

## Usage

```bash
# the generated tool index (name · one-line purpose) — start here (the originating work item)
node packages/pipeline-cli/src/bin.ts commands compact

# the effect/unstable/cli --help listing of registered tools
node packages/pipeline-cli/src/bin.ts --help

# dispatch to a registered tool
node packages/pipeline-cli/src/bin.ts <tool> …
```

### `gh-compat` — repository-configured GitHub CLI compatibility and corpus lint

The generic successor to the source-specific `gh-phoenix` package. It preserves the original
two independent capabilities without imposing a GitHub-provider limitation on every adopter:

- **`gh-compat lint-skills <file>...`** validates strict YAML frontmatter in scoped skill and
  agent definitions, reports the exact scanned scope, and fails closed when it scanned no required
  files. When `.pipeline/agent-policy.json` explicitly enables a REST-only compatibility rule, it
  also reports configured `gh` invocations that would violate that rule.
- **The toolkit-local `gh-compat` shim executable** is an explicit wrapper for a repository that
  has enabled `github.cliCompatibility.pathShim`. It safely passes ordinary calls through,
  blocks the explicit `gh api graphql` transport in REST-only mode, rewrites only configured
  supported edit operations to REST, strips only configured unsupported JSON fields, and blocks
  an unprovable or unsupported rewrite with a remediation. It never
  changes PATH itself.

The PATH wrapper is intentionally opt-in. Configure the repository policy first, then place a
wrapper at `.pipeline/toolkit/templates/pipeline/gh-compat-wrapper.sh` ahead of the real `gh` only
in the agent environment that needs the compatibility rule. Do not add it to a global shell profile.

### `class-probe` — shared, fail-closed review routing

`class-probe classify` turns newline-delimited changed repository paths into the complete set of
artifact classes or review namespaces that must be dispatched and verified. It is the one shared
authority for the reviewer fan, `ship-it`, and the delivery workflow; no consumer should reproduce
the routing rules with a shell `grep` or a second Node classifier.

- `pipeline-cli class-probe classify` prints `has-code`, `has-docs`, `has-skills`, and additive
  `has-design` classes in stable order.
- `pipeline-cli class-probe classify --namespaces` prints the corresponding `review-code`,
  `review-doc`, `review-skill`, and `review-design` namespaces. These values can be passed directly
  to `pipeline-cli verdict read --gate`, which also accepts the namespaced form.
- The repository owns its pattern taxonomy in `github.review.classification` in
  `.pipeline/agent-policy.json`: code and skills are include matches; docs and design are
  carve-then-test include/exclude matches. Empty design includes deliberately mean no design
  surface. No product, framework, or UI path is a hidden command default.
- For delivery decisions, pass `--policy-ref <base-sha-or-ref>`. The tool reads policy through
  `git show`, preventing a PR from relaxing the rules used to decide its own required review set.
- A non-empty diff outside every configured class receives `review-code`. Missing, malformed,
  unreadable, or invalid policy over-dispatches every namespace; an empty diff emits no namespace.

```bash
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
  | pipeline-cli class-probe classify --policy-ref "$BASE_POLICY_SHA" --namespaces
```

### `guard-content-probe` — shared protected-decision classifier

Some repositories keep decision records on ordinary documentation paths, yet a record can still
change a safeguard by relaxing, widening, bypassing, or otherwise changing the rule that protects
delivery. A path alone cannot distinguish that protected decision from an ordinary record. This
tool gives review, delivery, and lightweight-review eligibility one conservative content decision
instead of three drifting shell predicates.

The command is portable core tooling; its convention is not. The repository owns the optional
`github.shipping.guardContent` section in `.pipeline/agent-policy.json`:

```json
{
  "enabled": false,
  "decisionRecordPaths": [],
  "vocabularyPatterns": []
}
```

The disabled, empty default means no decision-record convention has been configured. When an
adopter enables it, both arrays must be non-empty JavaScript regular-expression source strings:
`decisionRecordPaths` matches repository-relative changed paths, and `vocabularyPatterns` matches
a candidate record's body case-insensitively. The core ships no product, team, directory, or
safeguard vocabulary default.

- **`guard-content-probe candidates [--files-from FILE] [--root DIR] [--policy-ref REF]`** reads
  newline-delimited repository-relative changed paths from stdin (or `--files-from`) and writes
  only candidate paths to stdout. With a trusted enabled policy, it preserves input order and
  removes duplicates. An explicit disabled policy writes no candidates. A missing, unreadable,
  malformed, or invalid policy writes every non-empty input path and a diagnostic to stderr: the
  caller must then treat each path as unproven rather than silently declaring it ordinary.
- **`guard-content-probe classify [--body-file FILE] [--path PATH] [--root DIR] [--policy-ref REF]`**
  reads one candidate body from stdin or `--body-file`. It writes exactly `guard-touching` or
  `not-guard-touching` to stdout and puts the path plus a stable reason on stderr. Its exit code is
  intentionally inverted for shell gates: `0` means `guard-touching`; `1` means a readable body
  under a fully valid enabled policy proved `not-guard-touching`.

`classify` fails closed (`guard-touching`, exit `0`) when the body is empty, unavailable, or
unreadable, or when the applicable policy is missing, unreadable, malformed, disabled in an
unexpected form, incomplete, or contains an invalid pattern. An ordinary result is possible only
after a complete enabled policy and a readable, non-matching body. Argument and usage errors stay
ordinary CLI errors; diagnostics never contaminate the machine-readable stdout token.

### `design-token-guard` — optional, configured token-consistency guard

`pipeline-cli design-token-guard check` is disabled unless
`.pipeline/optional-workflow-policy.json` explicitly enables `adapters.designTokenGuard`.
The policy supplies the source globs, parser expressions, raw-layer paths, token exceptions,
and raw-pixel ratchet; it carries no framework, stylesheet root, or token naming default.
An enabled invalid policy or empty source scope fails closed. The command is read-only.

### `design-inventory` — optional, configured descriptive inventory

`pipeline-cli design-inventory generate|check` is disabled unless
`adapters.designInventory` explicitly supplies source globs, tag vocabulary, an artifact path,
and normative-artifact exclusions. `check` is read-only and fails on drift. `generate` writes
only the declared descriptive artifact; policy rejects an artifact that is named normative.

For review and delivery authority, pass `--policy-ref "$BASE_POLICY_REF"`. The command reads
`.pipeline/agent-policy.json` through `git show <ref>:.pipeline/agent-policy.json`; it must not
fall back to a pull request worktree that could weaken its own protection. A local invocation
without `--policy-ref` may use the worktree policy for authoring or configuration exploration, but
is not delivery authority.

```bash
# First select only the repository-owned decision-record candidates.
git diff --name-only "$BASE_REF"...HEAD \
  | node packages/pipeline-cli/src/bin.ts guard-content-probe candidates \
      --root /repo --policy-ref "$BASE_POLICY_REF"

# The caller retrieves each selected body at the current review head, then classifies it.
fetch_decision_body "$candidate" \
  | node packages/pipeline-cli/src/bin.ts guard-content-probe classify \
      --root /repo --policy-ref "$BASE_POLICY_REF" --path "$candidate" \
  && echo "protected decision: retain the advisory/approval route"
```

`review-code`, `review-doc`, and `ship-it` use this one decision to keep their existing authority
separation: reviewers preserve advisory evidence and the configured approval route owns delivery.
`trivial-diff` reuses the same policy/parser so a matching, deleted, unreadable, or unprovable
candidate is never eligible for lightweight review. An ordinary configured decision record can
still be considered under the normal size and path rules.

### `cp-cardinality` — deterministic protected-change approval discharge

`cp-cardinality decide` is the pure, local decision authority for a protected change after a
repository-owned approval-evidence adapter has resolved the facts. It does not read a forge,
team endpoint, pull request, comment, token, or policy file. The adapter supplies newline-delimited
eligible authority-member identities on stdin, the PR author, the configured threshold, the count
of distinct eligible non-author approvals bound to the current revision, and—only when proven—the
narrow sole-author exception fact.

The repository convention is explicit in `github.shipping.protectedChangeApproval` in
`.pipeline/agent-policy.json`. Its shipped default is disabled, with no organization, team slug,
or marker. When enabled, the repository chooses the approval-evidence adapter provider and team,
sets a positive `requiredNonAuthorApprovals`, and may enable a sole-author exception only with a
non-empty repository-owned `commentPattern`. Shipping resolves that policy from its immutable base
reference; a PR cannot relax its own approval authority or marker.

`cp-cardinality evidence-github-team` is the first explicit adapter. It takes
`--root <repository-root> --policy-ref <immutable-base-ref> --repo <owner/name> --pr <number>` and
emits exactly one JSON facts object on stdout:
`{members, author, requiredNonAuthorApprovals, nonAuthorApprovalsAtHead, soleAuthorExceptionAtHead}`.
It resolves the policy through that immutable reference and requires its enabled authority provider
to be `github-team`. Any unreadable policy, mismatched provider, missing team configuration, or
untrusted provider evidence is a diagnostic plus a non-zero exit, never an empty roster or an
approval fact. The adapter is deliberately separate from `decide`; another provider can produce
the same facts without changing the cardinality core.

The pure decision has four fail-closed authority shapes: an empty authority always stops; a
one-member authority whose member is the author can discharge only with the current-revision
sole-author exception; a one-member non-author authority and any multi-member authority require
the configured number of current-revision eligible non-author approvals. Blank or duplicate member
identities, a blank author, malformed counts, stale evidence, or an untrusted adapter result stop.
The command prints only `discharge` or `stop` on stdout, with its branch and reason on stderr;
exit status `0` means discharge and `1` means stop.

```bash
# Resolve evidence from the base policy, then pass only those facts to the pure decision.
facts="$(node packages/pipeline-cli/src/bin.ts cp-cardinality evidence-github-team \
  --root /repo --policy-ref "$BASE_POLICY_REF" --repo "$REPO" --pr "$PR")" || exit 1
printf '%s\n' "$(jq -r '.members[]' <<<"$facts")" \
  | node packages/pipeline-cli/src/bin.ts cp-cardinality decide \
      --author "$(jq -r '.author' <<<"$facts")" \
      --required-non-author-approvals "$(jq -r '.requiredNonAuthorApprovals' <<<"$facts")" \
      --non-author-approvals-at-head "$(jq -r '.nonAuthorApprovalsAtHead' <<<"$facts")" \
      $(jq -e '.soleAuthorExceptionAtHead' <<<"$facts" >/dev/null && printf '%s' '--sole-author-exception-at-head')
```

The retained boolean `--non-author-approval-at-head` is a compatibility shorthand for a count of
one. It must not be combined with the count flag. A watcher may use `discharge` as a wake-up
predicate, but the shipper must re-fetch current-revision evidence and re-run this same command
immediately before enqueueing; no watcher result is merge authority.

### `epic-lock` — the epic mutation lock `status:planning` epic-lock (the originating work item)

The two-layer epic-plan lock the `plan-epic` / `review-plan` skills use to serialize
concurrent mutation of one epic's children, extracted from the ~50-line inline `jq` glue
each skill hand-rolled. It runs the authenticated, session-stamped claim protocol agent-distinguishable-claim protocol over the
the epic mutation lock `status:planning` lock-label:

- **`epic-lock acquire <epic>`** — coarse-label Rule-0 defer → POST the label (fail-closed on
  a 422 missing label) → POST the `claim: <session-id> · <ts>` comment → checkpoint-GET →
  resolve the **earliest authorized claim** (write+ collaborators only, the runtime ACL authorization rule). **Exits 0
  only when the lock is ours;** every fail-closed back-off (held label, 422 missing label,
  failed claim post, lost co-acquire, missing `CLAUDE_CODE_SESSION_ID`) prints a reason on
  stderr and exits **non-zero**, so a caller branches on exit status.
- **`epic-lock release <epic>`** — retract our own claim comment(s) (re-found by session id)
  and DELETE the label (404-benign, **loud** on any other DELETE failure — a swallowed DELETE
  leaks the lock and wedges the epic).

The session id is `$CLAUDE_CODE_SESSION_ID`; `--session` overrides it (the orchestrated
delegated-token path, and tests). The pure claim-resolution decision (`claim-resolution.ts`)
is IO-free and unit-tested table-driven; `github.ts` is the REST-only `gh api` boundary — the
**template `github.ts` service pattern** reused by the later tool families.

```bash
# acquire (exit 0 = held by us; non-zero = backed off, do not mutate)
node packages/pipeline-cli/src/bin.ts epic-lock acquire 1234 && echo "hold the lock"
# release on every terminal path
node packages/pipeline-cli/src/bin.ts epic-lock release 1234
```

### `verdict` — the SHA-bound, one-verdict-per-gate contract SHA-bound gate-verdict read/post glue (the originating work item)

The SHA-bound verdict read/post glue the `review-*` / `ship-it` / `write-code`-repair skills
each hand-rolled inline as `jq`, extracted into one deterministic, unit-tested tool. The
**pure core** (`verdict-match.ts`) is the verdict-match decision: given a PR's comment bodies
+ the current HEAD sha + the write+ authorized-author set, is HEAD reviewed in this gate's
namespace, and by which marker? — with the discriminator the inline reads got subtly wrong
made explicit (a SHA-less advisory does **not** satisfy a SHA-bound check; a verdict bound to a
stale head does **not** pass; newest-authorized-marker wins). It re-encodes the SHA-bound, one-verdict-per-gate contract match
semantics; it does **not** change what any gate verifies.

`verdict post` refuses a **self-verdict** (exit 10) over the identity it READS, not one the caller
declares: `gh api user` names the account the comment will belong to, and a match against the PR's
author is refused. `--as` survives only as an assertion — a disagreement with the authenticated
account is itself a refusal (exit 10), and an unreadable identity refuses as `PRECONDITION_UNKNOWN`
(exit 11) rather than posting an ungated verdict. It previously compared `$CLAUDE_CODE_SESSION_ID`
against a GitHub login — two kinds of thing that cannot be equal — so the refusal was unreachable
through every documented invocation (#53).

`verdict post` also refuses a **namespace the diff does not require** (exit 7): the PR's changed
files are classified through the repository policy, and a `--gate` outside the required set names
what the diff does require instead of posting. The check needs a TRUSTED policy — from a root
without one it warns that it did not run and lets ship-it re-derive the scope at the merge; it
never guesses from the fail-closed classify-everything fallback, which would make every namespace
"required" and the refusal unreachable (#66).

- **`verdict read --pr N --gate <code|doc|skill|design> [--expect PASS|FAIL] [--head <sha>]`** —
  resolve the (PR, gate) verdict against the PR's current head (author-gated to write+
  collaborators, the runtime ACL authorization rule). Prints the resolved outcome as JSON on stdout (`_tag` of
  `current`/`stale`/`sha-less`/`none`, plus the bound sha + comment id); **exits 0 only when HEAD
  is reviewed with the `--expect` polarity** (default `PASS`; `FAIL` is the `write-code`-repair
  seam), non-zero with a named refusal reason on stderr otherwise — so a caller branches on exit
  status.
- **`verdict post --pr N --gate <g> [--body-file <f>]`** — the SHA-bound, one-verdict-per-gate contract rule-2 **upsert**: read
  the composed verdict body (from `--body-file` or stdin), refuse fail-closed if its first line is
  not *this* gate's marker (the cross-namespace emission bug), then PATCH our own prior marker in
  the namespace if one exists, else POST — exactly one verdict comment per (PR, gate). It then
  **re-fetches the landed comment and re-runs `emissionDefect` on its body** (the folded-in
  self-verify, the originating work item): a body that passed the input gate but did not land as a clean in-namespace,
  leak-free marker fails the post (non-zero) instead of reporting a false success — closing the
  "called `post` but skipped the separate verify line" gap. Prints `patched <id>` / `posted <id>`.

The pure match core (`verdict-match.ts`) is IO-free and unit-tested table-driven; `github.ts` is
the REST-only `gh api` boundary (the `epic-lock` `github.ts` service pattern).

```bash
# is PR 123's doc verdict a current-head PASS? (exit 0 = reviewed)
node packages/pipeline-cli/src/bin.ts verdict read --pr 123 --gate doc && echo "merge-ready"
# upsert a composed review-doc verdict (one comment per gate)
node packages/pipeline-cli/src/bin.ts verdict post --pr 123 --gate doc --body-file "$VERDICT_FILE"
```

### `intake-dedup` — the unified deterministic intake-dedup rule unified intake-dedup check (the originating work item)

The "is there already an open issue for this?" query the `report` (pre-file) and `triage`
(intake board-read + split-pre-create) skills each used to hand-maintain inline, extracted
into one deterministic, unit-tested tool wired at both intake seams — so the agent path and
the human path share one implementation and cannot drift. The **pure core**
(`dedup-match.ts`) is IO-free: `tokenize` + `searchQuery` shape free text into a deterministic
GitHub search, and `rankCandidates` fuses the two result sources (the read-after-write
`needs-triage` queue + the eventually-consistent search index) into one deduped,
title-overlap-ranked candidate list. `github.ts` is the REST-only `gh api` boundary (the
`verdict`/`epic-lock` `github.ts` service pattern).

- **`intake-dedup check --query "<text>" [--exclude N] [--label L] [--limit N]`** — prints one
  `#<n>\t<title>` line per candidate duplicate to stdout (empty ⇒ no likely match) and the
  count on stderr. Advisory, not an oracle (a duplicate is cheap to close, a lost observation
  is gone): **always exits 0**. `--exclude` omits an issue number (the one being deduped at the
  triage seam, so it never flags itself); `--label` overrides the intake-queue label
  (default `status:needs-triage`). It resolves the target repo itself (the repository-resolution contract §1).

```bash
# pre-file check (report seam) — pass the title + a few keywords, not a hand-built query
node packages/pipeline-cli/src/bin.ts intake-dedup check --query "retry helper swallows abort reason"
# triage intake check — dedup the issue against the board, excluding itself
node packages/pipeline-cli/src/bin.ts intake-dedup check --query "<title + keywords>" --exclude 2802
```

### `leak-guard` — personal-data leak gate for shared artifacts (the related failure modes)

Four verbs over the shared deny-list-per-surface core (`findLeaks` for doc files, the stricter
`findCommentLeaks` for comment bodies):

- **`leak-guard scan <file>…`** — the changed-file gate (the originating work item): reports any user-local
  filesystem path leaking into a shared **doc surface** (`.md`, `.decisions/`, `.patterns/`),
  exit 2 on a hit. CI hands it every changed file; the core (`findLeaks`) self-scopes to doc
  surfaces.
- **`leak-guard scan-comment [--body-file <f>]`** — the pre-post net for a single PR/issue
  **comment body** (stdin or `--body-file`, the originating work item): a comment is unconditionally a public
  artifact, so `findCommentLeaks` runs with no doc-surface gate and stricter temp-root
  patterns — exit 2 on a leak, run before a `gh api …/comments` post.
- **`leak-guard scan-pr <PR>`** — the **landed-comment** scan (the originating work item): fan `findCommentLeaks`
  over a PR's already-posted comments — the issue conversation **and** the inline review
  comments, fetched over `gh api` REST — reporting each leak as `<kind> comment <id>: <span>`,
  exit 2 on a live leak. This is the check no emit-side guard can offer: it catches a leaked
  comment **regardless of emit path** (a raw `gh api -f body=@$FILE` bypass, the related failure modes), which
  is why `ship-it` runs it as a pre-enqueue preflight (its Step 3.7) and refuses to merge on a hit.
- **`leak-guard sweep [--dir <d>] [--root <r>]`** — the pipeline-crew sanitization sweep
  (the originating work item, crew the originating initiative Phase 4). The crew plugin ships **zero real operator data**, so
  its whole tree is swept by a **purely generic, pattern-based** personal-data detector —
  it catches only **structural pattern classes**, never a hardcoded person identifier:
  machine-local / home / absolute **paths**, any **email**, **tmux pane ids**, and
  **personal-memory references**. Fails closed (exit 1) on any hit **and** on a zero-file scope
  (the zero-scope fail-closed invariant), mirroring the readme-guard/fanout-guard directory-check idiom. The pure match-class
  core (`crew-leak.ts`, unit-tested class by class) carries **no named operator deny-list** — a
  bare first name in prose is deliberately NOT caught (generic over named: the high-value
  leaks are all pattern-detectable, whereas bare-name matching is low-value and
  false-positive-prone).

```bash
# changed-file doc-surface scan (exit 2 on a leak)
node packages/pipeline-cli/src/bin.ts leak-guard scan path/to/file.md

# scan a PR's landed comments (issue + review) — the ship-it pre-enqueue preflight (exit 2 on a leak)
node packages/pipeline-cli/src/bin.ts leak-guard scan-pr 123

# sweep the whole pipeline-crew tree (exit 1 on any hit or zero scope)
node packages/pipeline-cli/src/bin.ts leak-guard sweep
```

Both modes are wired as CI gates (`leak-guard.yml` for `scan`, `crew-leak-guard.yml` for
`sweep`) — the scan lives once in the tool, never re-grepped in the workflow.

### `main-sync` — codified orchestrator main-sync with detached-HEAD auto-reattach (the originating work item)

The single runnable surface for the orchestrator's **main-sync** — bringing the shared
primary checkout up to `origin/main` before/after an unattended drain. It replaces the
hand-run `git fetch origin main && git merge --ff-only origin/main` that lived only in
operator memory (the originating work item diagnosis, Unit C), and — the new capability — **auto-reattaches a
detached primary HEAD to `main` first**, so a stray detach during a heavy parallel drain
can't wedge the sync with a silent *"Not possible to fast-forward"* until a human notices.

Safe by construction (the pure core `main-sync.ts` decides, `command.ts` runs it):

- A reattach `git checkout main` is authorized **only when the working tree is clean**. A
  dirty off-`main` HEAD is **detect-and-surface** (`blocked-dirty`): the tool refuses to
  `checkout` and reports the dirt for a human, never blindly discarding uncommitted work —
  consistent with the documented failure incidents, which were always clean.
- The sync merge is `git merge --ff-only origin/main` — fast-forward only, so it never
  creates a merge commit and fails loudly rather than diverging the primary.
- **Dry-run by default:** with no flag it probes HEAD, prints the plan it *would* run, and
  exits 0 without touching anything (not even a fetch). `--execute` runs the plan.

```bash
# before/after a drain: print what main-sync would do (dry-run, nothing touched)
node packages/pipeline-cli/src/bin.ts main-sync

# actually reattach (if detached+clean) then fetch + merge --ff-only origin/main
node packages/pipeline-cli/src/bin.ts main-sync --execute
```

#### `--post-merge` — the gentle post-merge refresh (the originating work item)

Every pipeline agent works in an isolated `git worktree` (correctly — the worktree dependency-provisioning rule), so
*nobody ever pulls the primary checkout*. Under the merge queue (the merge-queue base-freshness rule) a PR lands
GitHub-side with **no local `git merge` on the primary** to advance it, so the owner's
checkout **silently drifts behind `origin/main`** — and any read of the local tree (the
next-free ADR number, "does file X exist yet", "is this already on main") is then made
against stale state. A local `post-merge` lefthook can't fix this (the triggering local
merge never happens under the queue); the refresh must be driven by a pipeline step that
*knows* a PR merged (`ship-it` / the orchestrator), which invokes:

```bash
# after a PR lands: fast-forward the primary IF it's on a clean 'main', else no-op (exit 0)
node packages/pipeline-cli/src/bin.ts main-sync --post-merge --execute
```

`--post-merge` is the **HEAD-preserving** counterpart to the default drain-sync — it is
gentle where the default is aggressive:

- It **only** fast-forwards when the primary is already on a **clean `main`** — the one
  state where `merge --ff-only` is both possible and non-destructive.
- On a **non-`main` branch** (the owner is on their own feature branch, or detached) **or a
  dirty tree**, it **leaves the checkout alone and exits 0** — it never reattaches, never
  moves HEAD, never touches uncommitted work. Failing-to-refresh is acceptable (a stale
  checkout is no worse than today); clobbering the owner or yanking them off their branch
  is not.
- It still `--ff-only`, so even on the fast-forward path it aborts on any divergence and
  never force-updates.

The refresh **wiring** into `ship-it`'s post-landed step is tracked separately (the originating work item); this
tool ships the safe refresh *mechanism* those steps invoke.

It is a **control-plane** surface because it can update the shared primary checkout. It only
fast-forwards a clean `main` and otherwise leaves the checkout untouched.


### `ref-guard` — caller-agnostic ref-transaction guard for the configured shared primary

A fail-closed guardrail at Git's own **`reference-transaction`** boundary that refuses two
shared-primary hazards before Git changes any ref:

1. **A diverging `refs/heads/<primary>` ref-move** — an update that makes the configured or
   Git-discovered primary branch a non-fast-forward of its configured/discovered remote-tracking
   branch. This catches a direct `branch -f`, `checkout -B`, or `update-ref`, not merely a
   pipeline-initiated sync.
2. **A bare HEAD-detaching checkout on the shared primary** — `git checkout <sha>`,
   `checkout FETCH_HEAD`, or `switch --detach` that strands the human's shared checkout off its
   branch. The guard is scoped to the transaction that **writes the shared checkout's own `HEAD`**,
   which is not the same as the transaction a primary-checkout *caller* started: `git worktree add
   --detach` runs from the primary but writes the **new** worktree's HEAD, so it is allowed, as is a
   linked worktree's own later detach. Creating or detaching a linked worktree is the normal state
   for review worktrees and strands nobody. A detach Git performs as a step of a multi-step operation
   it is itself driving — `rebase`, `pull --rebase`, `bisect` — is likewise allowed: Git reattaches
   the shared HEAD in the same command, so nothing is stranded. Symbolic HEAD retargets and attached
   commits paired with a branch update are also allowed across Git's differing transaction
   representations.

**Why this is a Git hook, not an agent hook.** `worktree-guard` regulates managed agent tool calls.
Git's transaction boundary also sees a human shell, raw `git update-ref`, another hook, and every
other Git caller. This is the caller-agnostic primary-checkout containment layer those hooks cannot
provide.

Safe by construction (the pure `ref-guard.ts` decides; `command.ts` only gathers Git facts):

- Updates outside the resolved primary ref are untouched. A delete of the primary is refused; a
  same-value write is allowed (a standstill moves nothing — git validates an asserted old value
  before the hook fires); an equal-tip or provable fast-forward is allowed; an identified primary
  divergence, including an unprovable ancestry probe, is refused.
- A standstill is measured against the **ref store** as well as against the caller's assertion,
  because the two disagree. `git pack-refs` — so `git gc`, so the `gc --auto` inside
  `commit`/`fetch`/`merge`/`pull` — migrates a loose ref into `packed-refs` by writing it at its own
  current value with a **zero-filled** old value, which passes the asserted-old-value rung above and,
  on a primary that is merely *behind* its comparison ref, reads as a rewrite one rung down. So a
  write whose new oid already equals what the ref resolves to is allowed on that ground alone.
- A missing comparison ref allows a non-delete update: a fresh clone has no remote tip from which
  to diverge. An unresolvable primary branch is a no-op rather than an implicit `main`/`origin`
  assumption.
- The HEAD rung fires only when the **value Git has staged for the shared checkout's own `HEAD`** is
  this transaction's. Git reports a linked worktree's HEAD write with the same refname, the same
  zero-filled old value, and the same environment as the primary's, so no fact about the *caller*
  separates them; a ref lives in exactly one store, the primary's rooted at `$GIT_COMMON_DIR` and a
  linked worktree's at `$GIT_COMMON_DIR/worktrees/<name>`, so the store is what does. Under the
  `files` backend the guard **reads** `$GIT_COMMON_DIR/HEAD.lock` rather than stat-ing it: mere
  existence is the wrong question, because Git holds that lock for every write that dereferences
  through HEAD — `commit`, `reset --hard`, `stash push` — and a stale one outlives any interrupted
  Git, either of which would refuse an unrelated `worktree add --detach` all over again. Git writes
  the pending value into the lock before renaming it over `HEAD`, so requiring it to equal the new
  oid on stdin scopes the fact to this transaction; the residual overlap is a concurrent primary
  detach to the very same oid, which fails closed. Under `reftable` there is no per-ref lock or
  staged value, only a whole-stack lock every ref write from any worktree takes, so there the rung
  fires when the shared stack is locked and no linked worktree's is — which at worst stands down
  while a linked worktree happens to be writing. The backend is read from the store's shape rather
  than `git rev-parse --show-ref-format` (Git >= 2.45).
- A *same-value* HEAD write is **not** excused as it is on the branch rung above: `git update-ref
  --no-deref HEAD <oid> <oid>` reports the resolved oid as its old value and still detaches an
  attached primary.
- The command uses a dedicated refusal exit code (`3`). The installed wrapper turns only that code
  into a Git abort; missing Node, an unpacked toolkit, or another runtime failure fails open and
  cannot wedge every ref transaction in the repository.

The command and hook are core checkout safety. `pipeline init` installs the managed Git hook
automatically, just as the original repository's package prepare step installed its Lefthook
wrapper. `git.primaryBranch` and `git.primaryRemote` remain optional overrides only for repositories
where Git cannot unambiguously discover the primary branch and remote. Inspect its installed state
with:

```bash
pipeline cli ref-guard status
```

The installer writes only an empty hook slot or an exact prior managed hook. It refuses a foreign or
modified `reference-transaction` hook, never changes `core.hooksPath` or global Git configuration,
and removes only its exact wrapper through `pipeline cli ref-guard uninstall`. The shared hook
location covers the primary checkout and linked worktrees, and the runtime keeps their HEADs
distinct by the value staged in the shared ref store, not by which checkout invoked Git.

Git passes `<old> <new> <ref>` lines on stdin and honors a refusal only in `prepared`; `committed`
and `aborted` drain/no-op. The manual shape is:

```bash
printf '%s %s refs/heads/<primary>\n' "$OLD" "$NEW" \
  | node packages/pipeline-cli/src/bin.ts ref-guard reference-transaction prepared
# exit 0 = allow · exit 3 = deliberate refusal; other non-zero errors fail open in the wrapper
```

It protects the shared primary checkout at Git's ref boundary: a divergent/deleted configured
primary ref or bare primary `HEAD` detach is refused before it changes checkout state.

### `primary-index-guard` — staged-deletion containment at Git pre-commit

`primary-index-guard pre-commit` protects a different boundary from `ref-guard`: a mass deletion
can be a fast-forward and therefore pass a reference-transaction check. The guard reads only the
staged deletion set (`git diff --cached --name-status --diff-filter=D`) and refuses only when all
of the following are true:

- the checkout is proven to be the shared primary checkout (`git-dir == git-common-dir`);
- the repository has explicitly enabled `git.primaryIndexGuard`; and
- configured protected-path deletions meet the configured blocking threshold.

It never resets, unstages, checks out, removes a worktree, or edits the index. Linked-worktree
commits are allowed: the decision is scoped to the shared checkout, not a guessed branch name.
Protected prefixes and thresholds are repository policy; the portable template deliberately ships
none. The command exits `3` only for its established policy refusal. Normal allows exit `0`; Git,
Node, toolkit, policy, or other runtime failures must not impersonate a refusal.

Install the Git hook explicitly after configuring policy:

```bash
pipeline primary-index-guard install-hook
pipeline primary-index-guard check-hook
```

The installer writes only a marked managed `pre-commit` wrapper in the shared Git common hooks
directory. It refuses to replace an unrelated hook or hook runner. The wrapper turns only exit
`3` into a blocked commit and fail-opens for every other nonzero exit, so a damaged local toolchain
cannot wedge all commits. Local hooks remain bypassable; protected branches and CI remain the
repository's final authority.

`primary-index-guard record` is the optional read-only observability leg. It uses the same
classifier, can record a lower-threshold JSONL event outside the repository, and never affects the
pre-commit decision or exit result.


### `ship-digest` — the merged-since stakeholder projection

Renders a stakeholder-facing ship digest for a `--since` window from a pre-gathered merged-work
entries JSON. Unlike `changelog-derive`'s builder-oriented Keep-a-Changelog version sections,
this groups work by a repository-configured **category**, then by **milestone**, then by a
repository-configured **type**. Missing or unrecognized category/type/milestone data is surfaced
under a visible `Uncategorized` bucket; an entry is never discarded because the gather could not
classify it.

The tool is the pure projection only. It decodes the untrusted entries file at the command
boundary and accepts `{issue?, pr, title, type?, milestone?, category?, joinedCategory?,
releaseState?}`. `pr` and `title` are required. A malformed/unreadable file, invalid entry, or
failed output write is a typed non-zero exit; an empty valid array is a successful report stating
that nothing shipped in the window. Gathering the input is the caller's, not this tool's, and no
release provider, network command, or mutation is embedded in the CLI.

The category rule preserves the useful join-free mechanism without a product-specific taxonomy:
the direct PR category (`category`) wins, then the gather's joined metadata (`joinedCategory`),
then the policy's fallback category. Blank direct data is treated as absent. Temporary
`area`/`joinedArea` aliases remain accepted only to let existing gathered entries migrate; new
entries and policy examples use `category`/`joinedCategory`.

`github.shipping.shipDigest` in `.pipeline/agent-policy.json` supplies category/type display
order, labels, and fallback labels. It is display policy, not a provider configuration the CLI
will execute. Missing or malformed display policy uses a deterministic generic layout and emits a
diagnostic on stderr rather than borrowing another repository's taxonomy or hiding entries.

The digest also carries the **merged-versus-user-visible release-state axis**: each entry's
`releaseState` (`live` / `awaiting-release` / `dark` / `unknown`) gets an inline annotation, and
`dark`/`awaiting-release` entries get a distinct **"Currently dark — awaiting your release"**
callout before the grouped report. State comes from the gather's explicitly configured,
read-only release-state adapter. No resolvable evidence becomes `unknown`, never an assertion
that the work is live; `unknown` is deliberately not claimed as awaiting release.

```bash
node packages/pipeline-cli/src/bin.ts ship-digest derive --entries <file> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <file>] [--root <repository-root>]
```

With no `--out`, the Markdown body is stdout. With `--out`, stdout stays empty and a concise
completion line is emitted on stderr. The `--until` default is the current UTC date. The command
is intentionally a renderer: use the repository's authorized release process after reading the
report; do not treat it as a release action.

### `token-spend` — offline per-stage token-spend reporter (the originating work item)

Reconstructs a pipeline stage's billed token spend from its sub-agent transcript
(`<session>/subagents/agent-<id>.jsonl`) and prints the `formatSessionCost` headline over
the four-component breakdown — the one-command replacement for the hand-run `jq` in
[`reports/token-economics-measurement.md`](../../reports/token-economics-measurement.md)
§2. Claude Code does not persist its `cost.total_tokens` into the transcript, so the total
is summed from the per-message `usage` components over assistant messages
(`input + cache_creation + cache_read + output`); `cache_read` is kept on its own line as
the per-turn context-bloat signal, with `ex-cache-read` as the cross-run comparator. Reuses
`spawn-guard`'s `formatSessionCost` core read-only.

```bash
node packages/pipeline-cli/src/bin.ts token-spend <session>/subagents/agent-<id>.jsonl
```

### `pointer-guard` — fail-closed stale-pointer gate for `**/CLAUDE.md` (the originating work item)

Reads the **backticked repo-path pointers** in every git-tracked `CLAUDE.md`
("operate from the repo root, never `apps/web`"; a pointer at
`apps/web/worker/dom/settings.ts`) and exits non-zero when one no longer resolves
on disk — the reference class `doc-links` (the originating work item) cannot see, because it validates
markdown `[text](path)` links and *masks* code spans by construction. The two gates
are complementary: `doc-links` reads link targets and masks code; `pointer-guard`
reads code spans and ignores link syntax.

Precision over recall: it flags a token only when it is an unambiguous
repo-root-relative path (begins with a known top-level segment — `apps/`,
`packages/`, `.patterns/`, …; no scheme / glob / call / placeholder syntax), so a
`catalog:` / `type:bug` / `pnpm dev` / bare basename is left alone. Scoped to
`**/CLAUDE.md` — `.decisions/**` (immutable history that legitimately cites moved
code) and `.patterns/**` (which also cite external dependency source trees) are out
of scope. Fails closed on zero CLAUDE.md in scope (the zero-scope fail-closed invariant).

```bash
node packages/pipeline-cli/src/bin.ts pointer-guard check
```

### `path-filter-guard` — fail-closed ci.yml/deploy.yml path-filter sync gate (the originating work item)

Mechanizes the ci.yml/deploy.yml path-filter **sync invariant** (the originating work item). `deploy.yml`'s
`changes.deploy` dorny/paths-filter list and `ci.yml`'s `changes.e2e` dorny/paths-filter list
must be the **same set** of globs — pinning **deploy's RUN-set ⊇ e2e's RUN-set** (deploy skips a
preview only where e2e also skips). `ci.yml`'s `e2e` job polls `deploy.yml`'s sticky
`<!-- preview-deploy -->` comment on a 10-minute deadline, so a PR that trips e2e but skips its
deploy times the poll out and wedges `ci-required`. The two lists were guarded ONLY by a
reciprocal human comment; this makes the invariant mechanical.

Set **equality** is the checkable form (equality ⇒ superset, and equality is what the
comments pin). The pure core parses each workflow YAML, reads the `changes` job's
`dorny/paths-filter` `with.filters` string, and diffs the `e2e:` / `deploy:` lists as sets.
Fails closed on zero scope — a missing file/job/step/key or an empty list (the zero-scope fail-closed invariant). See the
tool README: [`src/tools/path-filter-guard/README.md`](src/tools/path-filter-guard/README.md).

```bash
node packages/pipeline-cli/src/bin.ts path-filter-guard check
```

### `trivial-diff` — deterministic fail-closed trivial-diff classifier (the diff-complexity routing rule §1, the originating work item)

Classifies a unified diff as `trivial` / `non-trivial` for the right-sized fan-out
(the trivial-diff rule: only small, single-concern, non-control-plane changes use the reduced independent review gate §1). A diff
is `trivial` only when a hard AND of mechanical bounds clears: a single changed file that is
doc/comment-only or under the line bound `N` (1), with no new surface — dependency / manifest /
migration / schema / config path or a new `export`/`import`/`require(` module edge (2), and no
control-plane path (3). The boundary is the **live** `CONTROL_PLANE_RE`, re-resolved from
`origin/main` at run time (REST raw, `?ref=main`) — never a snapshot. Fail-closed by
construction: a failed bound, a parse error, or an unreadable boundary all return
`non-trivial`, so a miss over-routes to the full (correct) fan-out, never under-gates. The
verdict word prints to **stdout**, the deciding reason to **stderr**. This child builds the
predicate only — it is **not** wired into the executor (the originating work item) and adoption of the lighter gate
is measurement-gated (the measured no-quality-regression methodology, the originating work item).

```bash
git diff origin/main... | node packages/pipeline-cli/src/bin.ts trivial-diff classify
node packages/pipeline-cli/src/bin.ts trivial-diff classify --diff-file d.patch --max-lines 20
```

### `glossary-drift` — out-of-band glossary-drift backstop (the vocabulary capture-and-backstop rule prong (b), the originating work item)

Diffs recent merges to `main` against [`.glossary/TERMS.md`](../../.glossary/TERMS.md) and
surfaces concept-level vocabulary drift the fail-closed `review-code` Step 3c gate
structurally cannot see — a term coined in a regular code PR that never routes through
`/adr` or `plan-epic`
(the glossary trigger rule: identify new domain concepts from changed code and maintain vocabulary outside the merge gate). The gate reads
structural path signals; this reads the *words* an author used to name what they shipped.

The heuristic (pure core, `drift.ts`): pull quoted phrases and the 2–3-word windows of each
merge **subject** (bodies are prose — only their quoted phrases count), drop filler-bounded
and nested windows, and keep only phrases NOT already covered by a declared TERMS.md term
(substring-tolerant). It is **recall-biased on purpose** — a false positive costs a triage
glance, not a merge round-trip, so a coinage is never silently missed.

**Off the per-PR blocking path by construction:** the tool exits `0` whether or not drift is
found — a hit is a **filed `status:needs-triage` issue** (`--file-issue`, the `report` skill's
intake path), never a non-zero gate exit — so it can never block a merge. It runs on a weekly
schedule (`.github/workflows/glossary-drift.yml`), accepting the merge-cadence lag the vocabulary capture-and-backstop rule
prices in for staying off the fail-closed gate.

```bash
node packages/pipeline-cli/src/bin.ts glossary-drift sweep                # print candidates, exit 0
node packages/pipeline-cli/src/bin.ts glossary-drift sweep --window 50    # widen the merge window
node packages/pipeline-cli/src/bin.ts glossary-drift sweep --file-issue   # on drift, file a status:needs-triage issue
```

### `resume-policy` — capped TRANSIENT-only auto-resume for crashed workflows (the capped transient-resume policy, the originating work item)

The pure decision behind the capped transient-resume policy main-loop auto-resume discipline: given a crashed
dynamic Workflow's `status: failed` signal + the per-run resume ledger, decide `resume`
vs `surface`. It **composes** the [`failure-classifier`](src/tools/failure-classifier/)
(the originating work item): auto-resume **iff** the crash classifies TRANSIENT **and** this run is under the
K=2 cap; a LOGIC crash (including every default-deny) surfaces immediately with zero
resume attempts, and a run already resumed twice surfaces (`cap-reached`) — a persistent
"transient" is a masked LOGIC error, so the cap bounds token burn even under an optimistic
misclassification (the load-bearing safety property).

The cap is counted **per `resumeFromRunId`**: a fresh run starts a fresh K budget, so K
counts resumes of the *same* run, not a global tally. The `resume` action carries the
`{scriptPath, resumeFromRunId}` the driving session re-invokes with (completed `agent()`
stages replay from the journal cache).

Only transient failures may resume, and each run has a bounded retry budget; logic failures and
exhausted retries surface instead of looping indefinitely.

```bash
node packages/pipeline-cli/src/bin.ts resume-policy decide \
  --reason "null subagent result" --run-id run_abc \
  --script-path .claude/workflows/drive-issue.js --prior-resumes 0   # → resume
echo '{"reason":"TypeError: …","resumeFromRunId":"run_x","priorResumes":0}' \
  | node packages/pipeline-cli/src/bin.ts resume-policy decide         # → surface (logic)
```

### `wayfinder-map` — parse + validate a `wayfinder:map` issue's state (the related failure modes)

The machine-readable substrate the `wayfinder` skill's fog-graduation and emission modes
read instead of prose-guessing a map's state. A `wayfinder:map` issue is the ideation-layer
map that sits upstream of the execution pipeline; its body carries four canonical sections
(`## Destination` / `## Decisions-so-far` / `## Open frontier` / `## Graduated fog`), defined
once in the [formats contract](../../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md).
This tool parses that body into `{destination, decisionsSoFar, openFrontier, graduatedFog}`,
validates it against a structural floor (the epic-ledger idiom: a closed defect enum, sorted
deterministically), and exposes a **graduation-readiness** predicate — is the open frontier
cleared of every *answerable* unknown (a well-formed, non-fork ticket), so the map is ready to
emit.

The tool is **read-only** — it parses and validates; the map's writes belong to the
`wayfinder` skill's chart/work modes. The pure core (`markdown.ts` parse, `validate.ts` floor
+ `isGraduationReady`) is unit-tested directly; the GitHub boundary (`github.ts`) fetches the
map body + its native sub-issues and resolves a frontier ref that names a non-sub-issue as
`DANGLING_FRONTIER_REF`.

```bash
# human verdict: valid/malformed + the graduation-ready flag
node packages/pipeline-cli/src/bin.ts wayfinder-map 2421

# the full parsed state + defects as one JSON object (what the skill modes / a CI hook consume)
node packages/pipeline-cli/src/bin.ts wayfinder-map 2421 --json
```

### `reachability-guard` — optional configured feature reachability

`reachability-guard check <feature-key>` preserves the source pipeline's useful completeness
contract without assuming a feature-flag provider, application layout, language, or test runner.
It is an **optional adapter**. With the default
`optionalAdapters.featureReachability.enabled: false`, it reports that no reachability gate was
evaluated and exits successfully; it does not invent a source model or scan unrelated files.

An adopter enabling it supplies repository-owned relative paths and regular expressions in
`.pipeline/agent-policy.json`: one declaration source, consumer roots and filename pattern,
journey roots and filename pattern, a declaration pattern (capture 1 = symbol, capture 2 =
feature key), a journey pattern (capture 1 = key), and an exemption pattern (capture 1 = reason).
Once enabled, the guard keeps the original strict behavior: a declared feature needs a configured
consumer **and** a configured journey registration, unless an immediately preceding doc comment
contains the configured exemption and a reason. Zero parsed declarations and unknown keys fail
closed, and failures name the missing evidence.

```bash
# Disabled safely unless the adopting repository has enabled and configured the adapter.
node packages/pipeline-cli/src/bin.ts reachability-guard check billing-redesign

# Evaluate an explicitly configured repository root.
node packages/pipeline-cli/src/bin.ts reachability-guard check billing-redesign --root /path/to/repo
```

## Building and testing

```bash
pnpm --filter pipeline-cli typecheck
pnpm --filter pipeline-cli test
pnpm --filter pipeline-cli build   # src → dist ESM
```
