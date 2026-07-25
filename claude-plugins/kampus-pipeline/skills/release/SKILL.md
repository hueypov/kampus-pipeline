---
name: release
description: Perform a human-authorized, documented release of a verified change. Use when the user explicitly asks to release, promote, or roll out a named change. It discovers the target repository's release procedure and refuses to guess a deployment platform, environment, or command.
---

# release

Release is the deliberate human act that makes a verified change available to
its intended users. This skill preserves that boundary for any repository: it
does not merge a pull request, invent a deployment mechanism, or treat a code
merge as proof of a release.

## Guard 0 — require explicit human authority

Run this skill only when the human explicitly asks for the release in the
current interactive session. An agent, scheduled crew role, or inferred intent
is not release authority.

If authority is missing, stop and state:

```text
release: refused — a release changes an external system and needs an explicit human request.
```

## Guard 1 — discover the repository release contract

Resolve the target repository from `CLAUDE_PIPELINE_REPO` or the current Git
checkout. Then look, in this order, for a repository-owned release contract:

1. `.pipeline/release.md` or `.pipeline/release.json`
2. `RELEASE.md`
3. The release/deployment section of the root `README.md` or `CLAUDE.md`

The contract must name, in plain language or commands:

- the target environment or release target;
- a read-only preflight check;
- a dry-run when the underlying release system supports one;
- the exact release command or human console action;
- a post-release verification check; and
- where to record the release result.

Do not infer these from application directories, a cloud vendor, an issue
label, a branch name, or a tool installed on the machine.

If no contract exists, stop without changing anything:

```text
release: blocked — this repository has no documented release contract.
Create .pipeline/release.md (or document the procedure in RELEASE.md) with preflight,
execution, verification, rollback, and recording instructions; then run release again.
```

## Guard 2 — establish the release target

Ask for a target when the human’s request is ambiguous. A target can be a
version, tag, pull request, issue, artifact, feature name, or environment,
depending on the repository’s contract.

Before executing anything, report the resolved target and the documented
procedure you will follow. Stop if the contract cannot map the target to one
unambiguous release action.

## Step 1 — run the documented read-only preflight

Run only the preflight specified by the target repository. Confirm at minimum:

- the requested target exists and is the intended revision or artifact;
- the target has passed the repository’s required verification;
- the target is not already fully released; and
- the documented release target/environment is correct.

If preflight reports an unhealthy, unavailable, or already-complete state,
stop and report the evidence. Never “fix” a failed preflight by guessing a
command or changing the target.

## Step 2 — dry-run, then execute

When the repository release contract provides a dry-run or preview command:

1. Run the dry-run.
2. Show the planned target and effect to the human.
3. Execute only the same documented action after the dry-run succeeds.

If the underlying release system has no dry-run, state that fact before the
external write and follow the contract’s confirmation/rollback procedure.

Do not substitute a provider-specific CLI, mutate an issue label as a release
signal, or run a command copied from another repository.

## Step 3 — verify the result

Run the repository’s documented post-release check. It must verify the
externally visible result, not merely that a command exited zero. Examples
include a deployment status endpoint, an artifact version query, an approved
smoke test, or a human-confirmed console state—whichever the repository owns.

If verification fails or is inconclusive, report the exact evidence and follow
the documented rollback/escalation procedure. Do not claim the release
succeeded.

## Step 4 — record a concise release note

Use the recording destination specified by the repository contract. Include:

```text
Release target: <target>
Environment: <environment or repository-defined target>
Preflight: pass
Execution: completed
Verification: pass | failed | inconclusive
Rollback: not needed | started | completed
```

The final response must distinguish **merged**, **deployed**, and **released**
when the repository treats them as different states.

## Non-goals

- This skill does not choose a release platform.
- This skill does not create or clear a repository-specific release queue.
- This skill does not make a feature flag live unless the target repository’s
  contract explicitly defines that as its release action.
- This skill does not authorize autonomous or scheduled releases.
