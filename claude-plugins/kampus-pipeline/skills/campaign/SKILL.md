---
name: campaign
description: Create, update, or close a bounded repository initiative that groups related work under an explicit repository-owned convention. Use for "start a campaign", "update campaign", "finish campaign", or "/campaign".
---

# campaign

A campaign is a time-bounded, named initiative that coordinates several related
issues without replacing normal issue ownership. This skill preserves that
purpose for any GitHub repository; it does not prescribe labels, milestones,
roadmap files, branch names, or a default branch.

## 1. Resolve repository and campaign contract

Resolve the target repository from `CLAUDE_PIPELINE_REPO` or the current Git
checkout. Then find the repository’s campaign convention in this order:

1. `.pipeline/campaigns.md` or `.pipeline/campaigns.json`
2. `ROADMAP.md` or `PROJECT.md`
3. the planning section of `README.md` or `CLAUDE.md`

The convention must define how the repository represents a campaign: for
example, a milestone, project field, label, issue body field, or roadmap row.
It must also define the allowed lifecycle states and who may close a campaign.

If the repository has no convention, do not invent one. Propose a small
`.pipeline/campaigns.md` contract and wait for the maintainer to adopt it.

## 2. Start a campaign

Collect or confirm:

- a concise campaign name;
- the outcome it intends to achieve;
- a clear inclusion rule for issues;
- an owner or coordinating role; and
- a completion condition.

Create the repository-owned campaign representation exactly as documented.
Attach only issues that meet the inclusion rule. Keep each issue independently
triageable and executable; a campaign is coordination metadata, not a reason to
hide missing requirements inside a parent ticket.

Record a short campaign summary containing the goal, scope boundary, current
state, owner, and links to the included work.

## 3. Update a campaign

On each update, read the current campaign representation and report:

- completed work;
- open work and blockers;
- scope changes and their rationale; and
- whether the original completion condition is still valid.

Use the repository’s documented state transition. Do not silently add unrelated
issues, relabel all work, or derive status from a branch name.

## 4. Complete or close a campaign

Close a campaign only when its documented completion condition is met or an
authorized maintainer explicitly ends it. Preserve the historical record:

- mark its documented final state;
- close or update its milestone/project entry if the repository uses one;
- retain links to incomplete follow-up work; and
- summarize the outcome and remaining work.

If work remains but the campaign is being stopped, use the repository’s
documented “cancelled” or “deferred” state. Never represent unfinished work as
completed.

## Git changes

When a campaign convention is stored in Git, work from the target repository’s
current upstream or default branch as discovered from Git. If the repository
does not expose an upstream/default branch, ask the maintainer for a base
revision rather than assuming `main` or a remote name.

## Non-goals

- This skill does not define a universal campaign taxonomy.
- It does not create a release, change deployment state, or alter external
  project-management systems unless the target repository documents that step.
- It does not replace issue triage, planning, implementation, or review.
