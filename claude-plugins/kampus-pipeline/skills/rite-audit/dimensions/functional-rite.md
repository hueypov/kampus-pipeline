# Functional journey

Use the target repository’s documented acceptance journey. Start from the
documented entry point, use only the provided test identity/fixture process,
and record each observable step.

Pass when the actor can complete the intended journey and observe the
documented outcome. Fail when a required step errors, produces the wrong state,
or exposes a contradiction in the repository’s acceptance criteria. Mark the
dimension blocked when the target, identity, or prerequisite data is not safely
available.

Evidence should name the action, resulting visible state, and the revision or
environment under test. Do not substitute a different feature or infer an
unstated expected result.
