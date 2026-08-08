---
id: 0002
title: A pull request's required gates are the union of both sides of its policy
status: accepted
date: 2026-08-08
tags: [gates, policy, merge, classification]
---

# 0002 — A pull request's required gates are the union of both sides of its policy

**What this decides:** Which review gates a pull request must carry is derived by classifying its changed paths against the classification policy at its base commit **and** the one at its head commit, requiring every namespace either side asks for. It is not derived from the policy in the caller's checkout, not from one side alone, and a disagreement between the sides does not refuse.

## Context

`ship-it check` is the only stage with merge authority. It decides which `review-*` verdicts a pull request needs by classifying the PR's changed paths through `.pipeline/agent-policy.json`, and it used to read that file from whatever working tree it happened to be run in.

That reading is wrong for exactly one class of pull request, and it is the class that matters most: **a pull request that changes the classification policy**. For every other PR the two sides are byte-identical and the defect is invisible.

**#93 is the live measurement.** It taught the policy to classify `claude-plugins/*/evals/` as a skills path — the whole point of the change — and it was gated by the rule it existed to retire. Classified against its base policy the diff needs `code` and `doc`; against its own head policy it needs `code`, `doc` and `skill`. It merged with two gates, and the namespace it introduced was never reviewed on the PR that introduced it. Replaying #93's verbatim changed-file list against its two verbatim policies reproduces this exactly, and — unlike the original run — the reproduction is checkout-independent.

The failure generalises in both directions:

- **Base only.** A PR that TIGHTENS the policy escapes the tighter rule it is adding, which is the #93 shape.
- **Head only.** A PR that DELETES a rule deletes the gate that would have reviewed the deletion. The rule being removed is precisely the one that should have routed the review of its removal.

The workaround this defect had already forced once was a human asserting `--gates` by hand (#120). That is a person supplying an answer the gate had all the inputs to derive.

## Decision

**A pull request's required gate set is the union of the namespaces its base policy requires and the namespaces its head policy requires, each policy read from its own commit.**

Union is the fail-closed reading, and it is the only candidate that needs no ruling on which side is authoritative. Both alternatives above under-require in a direction that is easy to exploit and hard to see; the union under-requires in neither.

**Refuse-on-disagreement was rejected, and something real is given up with it.** Refusing outright whenever the two sides classify differently is defensible — a policy change arguably is a human's call — but it makes *every* policy-changing PR wait on a person to assert what the gate could have computed, which is the workaround that produced this defect in the first place. The cost of rejecting it is stated plainly here so nobody has to rediscover it: `check` prints which namespaces exactly one side asked for, and that print is **information, not routing**. It has no exit code, no precondition, no label, and no comment, and neither `ship-it/SKILL.md` nor its contract instructs an agent shipper to read or act on it. A human watching a terminal learns the sides disagreed; the agent that actually merges does not. What refuse-on-disagreement would have bought was routing, and routing is not preserved.

**Reading two commits is a precondition, and it is met by fetching, not by falling back.** `git show <sha>:.pipeline/agent-policy.json` needs that commit in the local object store. The head commit is routinely absent: the head SHA moves on every push and `check` runs right after review, so a checkout that has not fetched since does not have it — and neither do `--single-branch` clones, `actions/checkout` with `fetch-depth: 1`, or a first look at any cross-fork PR. Two behaviours follow.

*The verb fetches the missing commit itself.* `templates/github/workflows/pipeline-delivery-gate.yml` already fetched the base SHA before classifying; the merge gate, added later against the same refs, did not. One consumer remembering and the next forgetting is the signal that the requirement belongs inside the function both call rather than in prose each must re-obey — the same preference ADR 0001 acted on.

*A ref that will not resolve even after the fetch is UNKNOWN scope, never a strict policy.* The tempting reading is to keep the classifier's fail-closed default and treat an unreadable policy as "classify everything". That inverts here. This repository configures `design` with no include patterns at all, so nothing can ever route a `review-design` gate; a fail-closed union requires it anyway, no reviewer can produce that verdict, and the merge gate becomes permanently unsatisfiable while printing a required set that reads like a legitimate answer. Not knowing what the rules are is a different fact from knowing they are strict, and only `PRECONDITION_UNKNOWN` says the first one.

Two further options were considered on that point and rejected. *Falling back to the worktree policy for the unresolvable side* reintroduces the checkout-dependence this whole decision removes — the answer would again depend on where the shipper is standing. *Never requiring a namespace whose configured include patterns are empty* does not even fix the case that exposed this: the fail-closed policy's `design` include pattern is `.`, not empty, so the union keeps it. The variant that would fix it — letting a trusted side veto an untrusted side's namespace — weakens fail-closed in order to hide an UNKNOWN, which is the wrong trade at a merge gate. The underlying hazard is real and is tracked separately (#137): a required namespace no configured policy can route is unsatisfiable however it arises.

**The two failure directions are deliberately different, because the two verbs are.** `ship-it` refuses on unknown scope: a merge on scope it could not establish is the one thing it exists to prevent. `verdict post` uses the same resolution for its namespace guard, and an unresolvable ref leaves that guard **unchecked** — warned aloud and allowed. It is not the last line of defence, `ship-it` re-derives the same scope at the merge, and blocking every review on an unreadable scope would stop all work to prevent something already caught downstream. A merge on unknown scope is unsafe; a review withheld on unknown scope is just lost.

**The base ref is the base branch's tip, not the merge base.** That is the correct side to read: the merge lands on that tip and its rules are the ones that will be in force. The consequence is that an open PR's required set can change when the base branch moves, with no push to the PR and no action by its author. `merge` re-derives every precondition immediately before merging rather than trusting an earlier `check`, which already covers this for the same reason it covers a moving head.

**Binding constraints.**
- `ship-it` and `verdict post` derive the required set through one function over one changed-file read. A reviewer and a shipper must not be able to compute different required sets for the same PR.
- Neither verb reads the classification policy from the working tree for a delivery decision.
- Both policy commits are resolved — fetching if necessary — before either policy is read.
- An unresolvable ref produces UNKNOWN scope, never a policy.

**Banned.**
- Deriving a PR's required gates from one side of its policy.
- Substituting the fail-closed classify-everything policy for a scope that could not be established, at any verb with merge authority.
- Reading the caller's checkout to answer a question about a pull request's rules.

## Consequences

Easier: a policy-changing PR is gated by the rule it introduces and by the rule it removes, with no human asserting `--gates`. `check` names both policies on every run, not only on a disagreement, so the required set is traceable to the two commits that produced it — the defect was invisible for as long as nothing named the policy in force.

Harder: the merge gate now depends on Git object availability, so it does network work it did not do before, and a repository with no remote to fetch from gets UNKNOWN where it previously got an answer. That answer was wrong, but it was an answer. The union can also require a namespace neither side would have required alone if a policy is malformed at one commit — a real, actionable, repository-owned condition, reported as untrusted on the `policy scope:` line.

**Not addressed here.**

- **The delivery-gate workflow still classifies against the base alone.** `templates/github/workflows/pipeline-delivery-gate.yml` calls `class-probe classify --policy-ref "$base_sha"`, which is one-sided. It fans reviewers OUT rather than deciding a merge, so its failure direction is a missed review rather than an unreviewed merge, and changing it means regenerating the workflow catalogue. Tracked in #129.
- **An unsatisfiable required namespace in general.** A namespace no configured policy can route is a hazard however it is required, including through a malformed policy or an explicit `--gates`. Tracked in #137.

## Records

Closes the design question behind #120; implemented in PR #128. The rationale previously lived only in a docblock in `packages/pipeline-cli/src/tools/ship-it/preconditions.ts`, which is not where a contributor asking why the merge gate unions two policies would look — that misplacement is what this record fixes.

**No vocabulary impact.** This decides how two existing things — the classification policy and a review namespace — combine for one existing artifact, the pull request. It coins nothing, so no `.glossary/TERMS.md` row is added.
