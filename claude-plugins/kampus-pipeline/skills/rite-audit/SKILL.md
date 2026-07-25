---
name: rite-audit
description: Run a repository-defined acceptance audit against a safe, non-production target and report evidence per dimension. Use for "run the acceptance audit", "audit this journey", "rite-audit", or "/rite-audit".
---

# rite-audit

`rite-audit` is an exploratory acceptance-audit harness. It keeps the useful
idea of walking a real user journey and recording raw evidence, but it does not
assume a product name, account tier, staging provider, deployment tool, or
application path.

## Preconditions

Before opening a browser, discover the target repository’s audit contract from:

1. `.pipeline/audit.md` or `.pipeline/audit.json`
2. `AUDIT.md`
3. the testing/acceptance section of `README.md` or `CLAUDE.md`

The contract must identify:

- a non-production URL or locally started target;
- a safe test identity or fixture process, if authentication is needed;
- the journey or feature to audit;
- the supported browser/test harness; and
- how to clean up any generated test data.

If the contract is absent or identifies production without an explicit,
repository-owned safety procedure, stop. Do not deploy, seed, mint accounts,
or infer credentials.

## Audit dimensions

Load the generic dimension guides in this directory and any additional
repository-owned dimensions named by the contract. Each dimension produces
observations, evidence, and a pass/fail/blocked result; it does not mutate the
target outside the documented test flow.

1. **Functional journey** — can the intended user complete the documented
   journey and observe the expected result?
2. **Accessibility** — are critical journey controls keyboard reachable,
   labeled, and free of obvious automated accessibility violations?
3. **Isolation and safety** — does the journey keep one test actor’s data and
   permissions separate from another’s as the repository contract requires?

## Procedure

1. Record the target URL, revision, environment, identity/fixture source, and
   time window before testing.
2. Follow the documented journey exactly. Explore only directly adjacent states
   needed to verify an acceptance criterion.
3. Capture reproducible evidence for each observation: URL/route, action,
   visible result, browser/test output, and screenshot or trace when available.
4. Mark a dimension **blocked** when the required target, identity, or harness
   cannot be obtained safely. A blocked audit is not a pass.
5. Clean up only through the repository’s documented test cleanup procedure.

## Output

Return raw findings, not a release decision:

```text
Target: <URL or local target>
Revision: <commit/tag>
Dimension: <name>
Result: pass | fail | blocked
Evidence: <concise reproducible evidence>
Follow-up: <issue/PR suggestion, if needed>
```

This skill never deploys or promotes a target. A repository may use its
findings as release evidence, but that decision belongs to its documented
release process.
