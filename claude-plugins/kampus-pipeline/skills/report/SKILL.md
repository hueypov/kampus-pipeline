---
name: report
description: File a follow-up GitHub issue the moment you spot work you won't do right now — a bug, a refactor, a design question, an investigation, missing tests, a confusing convention. Trigger autonomously, mid-task, without asking permission, whenever you notice something worth tracking but tangential to what you're doing. Also trigger on "file an issue", "report this", "open a follow-up", "track this for later", "/report".
---

# report

You spotted something while doing other work. Capturing it must cost you almost nothing — file it and get back to your task. This skill is the seam between "I noticed X" and a triageable GitHub issue, so observations don't die in the conversation.

File autonomously when the repository's contributor guidance permits agents to create GitHub issues. Do **not** propose-first or ask for permission in that configured workflow — the point is to capture a concrete observation before it is lost. The issue is deliberately unclassified intake: a repository may later triage it through people, automation, labels, or another tool, but this portable skill does not assume any of those stages exist. Your job is to capture context faithfully, not to judge it.

## What you are NOT doing

- **No type.** Don't decide if it's a bug / feature / chore / decision / investigation / epic. Classification belongs to the adopting repository, if it uses classification at all.
- **No priority, no severity.** Don't apply priority labels or describe something as critical/blocker/minor in a way that pre-empts the repository's later assessment.
- **No solution lock-in.** Your "suggested next step" is a non-binding hint, explicitly the reporter's guess, not a mandate.

Apply **no labels by default**. A repository-owned adapter may add labels after it documents their meaning and authority, but this portable intake must not invent queue state. Typing or prioritizing at filing time would make a reporter's guess look indistinguishable from a repository decision.

## Lead with a plain-language summary

Before the structured sections, open the body with a **plain-language, human-first
summary — 2–3 sentences a reader grasps on a skim**: what you observed and why it's worth
tracking, in prose, no jargon. It **precedes, never replaces**, the structured body below, so
the next reader can understand the observation before interpreting its metadata. Give it the
heading `## Summary`.

## The 5-section body template

The body is **type-blind** by design: the same five sections fit a bug, a refactor, a question, or an investigation, so you never have to classify to file. Under the `## Summary` lead above, use these exact section headings:

```markdown
## Summary
<2–3 plain-language sentences a reader grasps on a skim: what you observed and why it's worth tracking. The human-first lead, before the structured sections below.>

## What I was doing
<The task in flight when this surfaced. One or two sentences. Concrete: what file, what feature, what command.>

## What I observed
<The thing itself. Be specific and factual. Paste the error, name the function, quote the surprising line. This is the load-bearing section — triage acts on it.>

## Why it matters
<The cost of leaving it. Who or what is affected, and roughly how. Honest about uncertainty — "might cause X" is fine. Don't inflate to manufacture urgency; don't downplay to be polite.>

## Pointers
<Where to look: repo-relative file paths (e.g. `src/worker/...`), function names, related issue/PR numbers, ADR/pattern doc links. Give the next reader a running start.>

## Suggested next step (non-binding)
<Your best guess at a first move, clearly labeled a guess. "Maybe extract the retry logic into a helper" — not "Extract the retry logic." Triage and the implementer are free to ignore this. Leave it blank if you genuinely have no idea; an empty hint is better than a misleading one.>
```

Keep it tight. A faithful three-line observation beats a padded essay — triage needs signal, not volume.

## The metadata footer

Below the five sections, append a footer carrying the machine context of the session that filed the report, so triage and future debugging can trace which run produced it. Fields are **best-effort**: include what's available, omit silently what isn't (don't write "unknown" or leave dangling labels).

Gather the context with the helper, which reads it from the environment and git:

```bash
claude-plugins/kampus-pipeline/skills/report/footer.sh
```

It prints a ready-to-append markdown block. Which fields appear varies by run — the helper includes only what the environment actually exposes and silently drops the rest, so a real footer might look like this (here `session` and `model` weren't available, so they're omitted — no dangling labels, no "unknown"):

```markdown
---
<sub>Filed by an agent · branch `<prefix>/some-branch` · 2026-06-12T08:14:01Z</sub>
```

Aim for **session id, model, branch, and timestamp** — but all are best-effort. Model and session often come from env vars that are unset, so don't be surprised when they drop; whatever the helper can resolve is what you get.

### Footer privacy — non-negotiable

The footer is machine context, never personal context.

- **No PII.** No email addresses, no usernames tied to a person, no author identity. `git config user.email` and `user.name` are off-limits — that's why the helper never reads them.
- **No user-local absolute paths.** Never `/Users/...`, `~/.claude`, `~/.configured automation identity`, or any home-directory path. Paths in the body's Pointers section must be repo-relative. The footer carries no paths at all.

If you ever assemble the footer by hand instead of via the helper, apply the same rule: machine/session context only, and scrub anything that could identify a person or leak a local filesystem layout.

## Filing the issue

Use the authenticated `gh` CLI when this repository permits agents to file GitHub issues. Do not hard-code a repository name or inherit an organisation-specific API rule. The portable contract is GitHub-backed collaboration when configured, not a requirement that every repository use a particular board, label taxonomy, query endpoint, or issue workflow.

**Resolve the target repo once, up front.** Every GitHub operation targets `$REPO`, not a hardcoded repository. Prefer the explicit `CLAUDE_PIPELINE_REPO` override; otherwise resolve the current checkout. If neither is available, return the complete issue draft and explain that a repository target is required before it can be filed. Do not guess an owner/repository name from prose or a sibling checkout.

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

1. Write the title: a short, specific, type-neutral summary of the observation (≤ ~70 chars). Good: "Retry helper in http worker swallows the abort reason". Bad: "Bug in worker" or "BUG: fix retry".
2. Build the body: the `## Summary` lead, then the five sections, then a blank line, then the footer block from `footer.sh`.
3. **Re-query for an existing issue — always, and last.** Report agents can run concurrently, so the same observation may have been filed minutes earlier. Run this check *after* composing the body and immediately before the create call; composing first keeps the check-to-create window as small as practical. Search the current repository's open issues with the title and a few distinguishing keywords, using the query interface available to the configured `gh` installation:

   ```bash
   gh issue list --repo "$REPO" --state open \
     --search "<the title plus distinguishing keywords>" \
     --limit 20
   ```

   Treat the output as candidates, not an oracle. Search indexes can lag and similar titles can describe different observations. Read the candidate bodies before deciding. If an existing issue covers the same observation, do not file a twin; add genuinely new evidence as a comment when the repository's contribution policy permits comments, then return to the original task. If results are ambiguous, file the specific observation rather than silently dropping it.
4. File the issue with **no labels by default**. A repository-owned adapter may add labels or workflow metadata after it has documented those semantics.

Build the composed body inside the current shell execution, then submit it directly to GitHub. The body must never be written to a fixed or shared temporary path: concurrent runs can otherwise overwrite one another and file the wrong report. A shell variable scoped to this one command is acceptable because it is not shared across runs; a quoted heredoc keeps Markdown, backticks, and nested fences intact. Use the public issue-create endpoint directly so this core skill has no hidden dependency on a non-installed pipeline command:

```bash
TITLE="<short, specific, type-neutral title>"
BODY="$(
  cat <<'EOF'
## Summary
…

## What I was doing
…

## What I observed
…

## Why it matters
…

## Pointers
…

## Suggested next step (non-binding)
…
EOF
  echo # blank line before the footer block
  claude-plugins/kampus-pipeline/skills/report/footer.sh
)"

gh api --method POST "repos/$REPO/issues" \
  -f "title=$TITLE" \
  -f "body=$BODY" \
  --jq '"#\(.number) — \(.html_url)"'
```

The body never lands on disk under a shared name. Do not “simplify” this into a fixed `/tmp/report-body.md`, a stable `$BODY_FILE`, or a user-local scratch path: those forms can leak machine paths into the issue or cross-file concurrent reports. If a repository wrapper needs a file-based transport, it must allocate a unique per-run path, remove it after the request, and keep it out of all public artifacts.

5. Report back to the user in one line: the issue number and URL printed by `gh api`. Then return to your original task — don't expand into classifying, planning, or fixing what you just filed.

## Failure handling and external authority

Issue creation is an external action. Attempt it only when the current repository's guidance permits GitHub issue filing and the observation is safely within that repository's scope. If `gh` is missing, unauthenticated, pointed at the wrong account, or unable to resolve `$REPO`, preserve the complete title and body in the response and state the exact filing blocker. Do not switch to a hard-coded repository, a personal fork, a sibling checkout, or a local text file that another agent will not discover.

Treat GitHub failures precisely. A duplicate candidate is not a network failure; inspect it and either add evidence or file a distinct issue. A permission error means the current identity lacks authority; do not retry through another account. A validation error from GitHub means the title or body needs correction; revise only the malformed field and repeat the same repository-targeted request. A transport failure can be retried once after confirming that the request did not create an issue, because a timed-out response may still have reached GitHub. In every case, keep the body free of local paths, secrets, personal identity, and guessed repository policy.

The portable default deliberately stops after filing. The issue URL is the durable hand-off; labels, milestone placement, assignments, project-board state, linked pull requests, and issue closure are separate repository-owned decisions. This prevents an observation from being silently converted into a workflow commitment merely because an agent noticed it.

## Conventions

This skill is a portable GitHub intake surface. Its body template, privacy rule, repository resolution, duplicate check, and no-label default are fully stated here so an adopting repository receives a complete contract. A repository may layer a richer triage, planning, label, or project-management workflow on top, but that adapter must remain optional and must not redefine a raw report as already classified.

- One observation, one issue. If you noticed two genuinely separate things, file two — don't bundle. A repository may later split or connect them, but clean intake preserves the evidence and the next action.
- The pre-filing re-query (step 3 above) is mandatory, but it is a search, not an oracle: when the results are genuinely ambiguous, file — a later duplicate decision is cheaper than losing an observation entirely.
