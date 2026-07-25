# Acceptance-audit dimensions

This directory holds reusable, repository-neutral audit dimensions. A target
repository may add its own dimensions through its audit contract, but each one
must be safe to run against the documented non-production target and must
produce reproducible evidence.

| Dimension | File | Question it answers |
|---|---|---|
| Functional journey | `dimensions/functional-rite.md` | Can the documented actor complete the intended journey? |
| Accessibility | `dimensions/accessibility.md` | Are the journey controls usable with keyboard and assistive technology basics? |
| Isolation and safety | `dimensions/sandbox-leak.md` | Does the journey preserve the documented data and permission boundaries? |

Dimensions describe what to observe; they do not prescribe a framework,
application path, authentication scheme, or release platform.
