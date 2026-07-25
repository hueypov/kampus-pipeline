---
name: what-shipped
description: Produce a repository-local readout of merged work and, when the repository supplies evidence, its deployment or release state. Use for "what shipped", "what did we ship", "ship digest", "what is live", or "/what-shipped".
---

# what-shipped

This skill gives a concise, evidence-based answer to “what changed for users?”
It is read-only. It works from the current Git repository and GitHub metadata;
it never assumes a cloud provider, feature-flag service, label scheme, product
area, or application directory.

## 1. Resolve scope and time window

Resolve the target repository from `CLAUDE_PIPELINE_REPO` or the current Git
checkout. Interpret a supplied window such as `since 2026-07-01` or `last 30
days`; otherwise ask for a window rather than silently selecting one.

Use Git history and `gh` to collect merged pull requests in that window. For
each entry, capture the PR number, title, merge time, author, linked issue when
available, and the commit SHA.

## 2. Classify only from repository evidence

Group items using evidence that exists in the target repository: changed paths,
PR labels, milestones, issue type, or a documented project taxonomy. Do not
impose a “product versus infrastructure” split or an `area:*` label convention.

If the repository has no usable taxonomy, report one chronological list. An
honest ungrouped report is better than guessed classification.

## 3. Determine deployment or release state

Read `.pipeline/release.md`, `.pipeline/release.json`, `RELEASE.md`, or the
root release/deployment documentation when present.

- If the repository defines a read-only way to map a merged revision to a
  deployment/release state, use that documented mechanism.
- If the repository records releases only through tags, releases, or GitHub
  deployments, report that evidence.
- If no reliable mechanism exists, mark the state as **unknown**. Do not infer
  “live” from a merge, a label, a feature-flag name, or an external platform
  from another repository.

The permitted states are:

```text
released     externally verified by the repository's documented mechanism
deployed     deployment evidence exists, but release-to-users is separate or unknown
merged       merged with no deployment evidence
unknown      the repository provides no reliable state evidence
```

## 4. Present the digest

Return a compact report:

```text
Window: <start> → <end>
Repository: <owner/repo>

Released
- #<pr> <title> — <evidence>

Deployed / release state unknown
- #<pr> <title> — <evidence or "no documented release evidence">

Merged
- #<pr> <title> — <merge time>
```

Include a short “needs release evidence” note only when the repository’s
documentation is missing or inconclusive. Do not recommend a specific cloud,
feature-flag, or release system.

## Non-goals

- This skill does not release, deploy, alter flags, or edit GitHub metadata.
- It does not query a provider-specific service unless the target repository
  explicitly documents it as the source of truth.
- It does not claim a change is live solely because it merged.
