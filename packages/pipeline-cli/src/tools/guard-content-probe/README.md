# guard-content-probe

`pipeline-cli guard-content-probe classify` — the **shared guard-touching decision-record
content probe**. It classifies one `.decisions/**` record as `guard-touching` (§CP by
content) or `not-guard-touching`, so the **review gate**, the **driver**, and **ship-it
Step 0** all reach the same §CP verdict for the same diff through one verb.

## Why it exists

`.decisions/**` is otherwise non-blocking — it auto-merges on a `review-doc` PASS. But a
decision record that **relaxes, amends, or widens an exemption on a documented guard** is
control-plane by *nature* (it weakens the pipeline's own guardrails), and its **path** is
indistinguishable from an ordinary record. Classify the change by contents and apply the
control-plane gate only when it relaxes a guard.

Path-only classification once let guard-relaxing records reach the final shipping stage as
ordinary work. This verb is the single content probe every stage now calls, so the
classification is consistent even when a later stage is bypassed.

## Generic content-shape, never a named list

The probe matches over **guard/fail-closed/enforcement vocabulary**, never a hardcoded
record/name list. An author-declared tag is self-defeating: the author who omits the guard
may omit the tag too, and a named deny-list cannot cover future wording. "You cannot relax
a guard without naming it," so a probe over guard vocabulary catches the class an author
tag would let slip.

## Single source

The canonical `GUARD_ADR_RE` vocabulary is **not** re-declared here — it is parsed from
`gh-issue-intake-formats.md` §CP, the one definition ship-it Step 0 and the reviewer fan
re-resolve (exactly as `class-probe` parses `HAS_*_RE`). There is no second copy to drift.

## Split of concerns

IO in the thin bin (`command.ts`) — reading the decision-record body from stdin and `GUARD_ADR_RE` from
the local §CP; the whole predicate in the pure core (`guard-content-probe.ts`). The **caller**
owns the `gh api` REST resolution of each `.decisions/**` file's body at the PR head.

## Fail-closed

Every ambiguity resolves to `guard-touching` (§CP): an unreadable §CP boundary defaults to
`.` (match-everything), an uncompilable regex matches everything, and a null/empty ADR body
(a delete/404/unreadable head) classifies guard-touching. The probe over-routes a
merely-guard-*citing* ADR to a cheap human approval rather than risk missing a
guard-*relaxer* that would auto-ship a weakened gate.

## Usage

```bash
# ship-it Step 0 / review gate: read each touched .decisions/** record body at head, probe it.
HEAD_SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"
echo "$FILES" | grep -E '^\.decisions/.*\.md$' | while IFS= read -r adr; do
  [ -z "$adr" ] && continue
  gh api "repos/$REPO/contents/$adr?ref=$HEAD_SHA" -H 'Accept: application/vnd.github.raw' 2>/dev/null \
    | node packages/pipeline-cli/src/bin.ts guard-content-probe classify --path "$adr" \
    && echo "BLOCKING ($adr — guard-touching decision record ⇒ §CP)"
done
```

The decision word (`guard-touching` | `not-guard-touching`) goes to **stdout**; a human
reason goes to **stderr**. Exit is **0 on `guard-touching`, 1 on `not-guard-touching`**, so
the gate bash fails closed with `… && echo BLOCKING`.
