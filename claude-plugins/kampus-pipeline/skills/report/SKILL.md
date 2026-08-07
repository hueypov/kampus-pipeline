---
name: report
description: File one issue the moment you notice work you will not do right now — a bug, a refactor, a design question, a missing test, a convention that confused you. Fire it mid-task, autonomously, without asking permission and without finishing what you were doing first: an observation that stays in the conversation dies there. Captures what you saw in six type-blind sections, checks whether it is already on the board, and files it as raw intake carrying one lifecycle stage and no classification. Also trigger on "/report", "file an issue", "report this", "open a follow-up", "track this for later". Done when the observation is on the board — a new issue at the needs-triage stage, or a note on the issue that already covered it — and you are back on the task you interrupted.
---

# report

**Intake, not judgment.** You saw something while doing other work. Capture it faithfully and get
back to your task — a later `triage` run decides what it is and what it is worth. This skill
records the observation and stops there.

Capturing is meant to cost you almost nothing, which is why there is no permission step. Proposing
first turns a five-second capture into a conversation, and the observation that waits for an answer
is the one that never gets filed.

## 1 — Write the observation

**Title first.** Short (aim under ~70 characters), specific, and type-neutral. *"Aborted requests in
the http worker surface as plain timeouts"* names what you saw. *"Bug in worker"* names nothing, and
*"BUG: fix aborts"* both types and prescribes before anyone has looked.

**Then six sections** — the same six whether you found a crash, a smell, or a question. That
sameness is what lets you file without classifying first:

- **`## Summary`** — 2–3 plain sentences someone grasps on a skim. It leads the body and never
  replaces what follows.
- **`## What I was doing`** — the task in flight when this surfaced. Which file, which command.
- **`## What I observed`** — the thing itself, factual and specific. Paste the error, name the
  function, quote the surprising line. Triage acts on this section; the rest orient it.
- **`## Why it matters`** — the cost of leaving it, honest about uncertainty. "Might cause X" is a
  good sentence. Inflating to manufacture urgency and downplaying to be polite fail identically:
  triage prices it wrong.
- **`## Pointers`** — repo-relative paths, function names, issue and PR numbers, doc links.
- **`## Suggested next step (non-binding)`** — your best guess, labeled a guess. Blank beats
  misleading.

**Record what you saw, not what it is.** No type, no priority, no *critical* / *blocker* / *minor*.
A hand-typed classification is indistinguishable from a triaged one, so a guess here silently
corrupts the signal triage runs on. One observation, one issue — two things you noticed are two
filings.

**Repo-relative paths only.** Never write a path that exists only on this machine — `/Users/…`,
`~/code/…`, a sibling clone. An issue is a shared artifact. Unlike `tracker post-verdict`, the
create path does **not** yet refuse a leak for you, so this one is on your judgment; when a local
path is genuinely the evidence, pipe the body through `pipeline cli redact-leaks` first, which
masks each path to its class rather than dropping it.

Done here when all six sections carry content, except the last, which may be empty.

## 2 — Check whether it is already filed

Report runs happen concurrently, so what you just saw may have reached the board minutes ago. Run
this **after** the body is written and immediately before filing, so the window between checking
and creating stays small:

```bash
pipeline cli intake-dedup check --query "http worker aborted request downstream plain timeout"
```

Candidates print to stdout as `#<number>\t<title>`; the count and any diagnostic go to **stderr**.

**Read stderr, not just stdout.** Two different situations both print nothing on stdout and both
exit 0:

- **A real "none"** — both sources were read and nothing open matched. stderr says
  `0 candidate duplicate(s)`.
- **A non-check** — your query carried no usable keywords, so nothing was compared at all. stderr
  says `no usable keywords in --query`. This is not a clean result. Re-query with the distinctive
  terms.

A non-zero exit is UNKNOWN, never "none". **When it is genuinely ambiguous, file it** — triage
closes a duplicate in seconds, and a lost observation is gone for good.

Done here when the outcome has told you which branch you are on:

- none, a re-queried non-check that cleared, or candidates that are not your observation → **step 3**
- a candidate you have read and judged to be the same observation → **step 4**
- a non-zero exit, or a non-check a re-query did not clear → **step 3**, and say in the body that
  the duplicate check did not run

## 3 — File it

The body streams in on stdin, so your markdown reaches the verb untouched — no temp file to collide
on, no `@path` form that would post the path instead of the contents. **Append the provenance
footer** after the sections and a blank line:

```bash
{ cat <<'EOF'
## Summary
…
EOF
  .pipeline/toolkit/claude-plugins/kampus-pipeline/skills/report/footer.sh
} | pipeline cli tracker create-issue --title "Aborted requests in the http worker surface as plain timeouts"
```

**The footer is never optional.** `triage` reads its presence as the filing-provenance signal:
a footer means an agent filed it, so triage may close it as unsalvageable; no footer means a human
typed it by hand, and triage must never auto-close it. An issue you file without one is
permanently mistaken for a human's and can never be killed. The script emits only machine context
— session, branch, timestamp — and drops any field the environment does not expose; it carries no
identity and no paths, so it never needs review.

The issue enters at the `needs-triage` stage by default. Do not pass `--stage` to send it anywhere
else, and do not apply a classification — that is triage's call, and this is the seam that keeps
its queue trustworthy.

Done here when the verb exits 0 and prints the number and URL.

## 4 — Add what the existing issue lacks

When step 2 found your observation already filed, do not file a twin. Add only what that issue does
not already carry:

```bash
pipeline cli tracker create-comment 4312 <<'EOF'
…
EOF
```

Done when the verb exits 0 and prints the comment reference.

## 5 — Report and return

One line: the number and URL the verb printed. Then **go back to the task you interrupted.** You are
not triaging what you filed, and you are not fixing it.
