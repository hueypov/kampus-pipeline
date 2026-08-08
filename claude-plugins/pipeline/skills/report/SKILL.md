---
name: report
description: File one issue the moment you notice work you will not do right now — a bug, a refactor, a design question, a missing test, a convention that confused you. Fire it mid-task, autonomously, without asking permission and without finishing what you were doing first: an observation that stays in the conversation dies there. Captures what you saw in six type-blind sections, checks whether it is already on the board, and files it as raw intake carrying no classification. Also trigger on "/report", "file an issue", "report this", "open a follow-up", "track this for later". Done when the observation is on the board — a new issue at the intake stage, or a note on the issue that already covered it — and you are back on the task you interrupted.
---

# report

**Intake, not judgment.** You saw something while doing other work. Capture it faithfully and get
back to your task — a later `triage` run decides what it is and what it is worth.

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

Done here when all six sections carry content, except the last, which may be empty.

## 2 — Check whether it is already filed

Report runs happen concurrently, so what you just saw may have reached the board minutes ago. Run
this **after** the body is written and immediately before filing, so the window between checking and
creating stays small:

```bash
pipeline cli report dedup --query "http worker aborted request downstream plain timeout"
```

The first line of output is the outcome, and only one of the three is about your observation:

- **`candidates`** — open each and judge it yourself. Shared vocabulary is not a shared observation.
- **`none`** — both sources were read and nothing open matched. A real answer.
- **`indeterminate`** (exit 3) — your query carried too few distinctive terms, so nothing was
  compared. **This is a non-check, not a clean one.** Re-query with the specific terms.

A non-zero exit other than 3 is UNKNOWN, never `none`. **When it is genuinely ambiguous, file it** —
triage closes a duplicate in seconds, and a lost observation is gone for good.

Done when the outcome has told you which branch you are on:

- `none`, a re-queried `indeterminate` that cleared, or candidates that are not your observation →
  **step 3**
- a candidate you have read and judged to be the same observation → **step 4**
- a failed check, or an `indeterminate` a re-query did not clear → **step 3**, and say in the body
  that the duplicate check did not run

## 3 — File it

The body streams in on stdin, so your markdown reaches the verb untouched:

```bash
pipeline cli report file --title "Aborted requests in the http worker surface as plain timeouts" <<'EOF'
## Summary
…
EOF
```

The verb owns what is mechanical: it validates the six sections, appends the provenance footer,
files at the intake stage, and reads back what landed. You supply the judgment — the title and what
goes in the sections.

**When it refuses, fix the input and run it again.** A refusal names one thing: an empty section, a
body that never reached stdin, a machine-local path, a title that classifies. **A refusal is never a
reason to post some other way** — reaching for a different mechanism is how a body gets replaced by
a path to the body.

Pass `--redact` when a machine-local path is genuinely part of the evidence — reporting a leak is
the case it exists for. It masks each path to its class and says so; it never silently rewrites what
you wrote.

Done when the verb exits 0 and prints the number and URL.

## 4 — Add what the existing issue lacks

When step 2 found your observation already filed, do not file a twin. Add only what that issue does
not already carry:

```bash
pipeline cli report note --issue 4312 <<'EOF'
…
EOF
```

No six-section template here — a note adds what is missing, and the full template would produce four
empty sections restating what is already there.

Done when the verb exits 0 and prints the reference.

## 5 — Report and return

One line: the number and URL the verb printed. Then **go back to the task you interrupted.** You are
not triaging what you filed, and you are not fixing it.
