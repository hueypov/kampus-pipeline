---
name: report
description: Capture a follow-up GitHub issue when work is discovered outside the current task. Trigger on "report this", "file an issue", "track this", or when an observation should not be lost.
---

# report

Create a concise, type-neutral follow-up issue and return to the current task.
Do not assign priority, severity, owner, or a project-specific label unless the
user explicitly asks for one.

Use this body structure:

```markdown
## Summary
<what was observed and why it matters>

## Context
<what you were doing when it surfaced>

## Evidence
<error, behavior, repository-relative paths, or related issue/PR>

## Suggested next step
<optional, non-binding idea>
```

Append the privacy-safe session footer:

```bash
.claude/skills/report/footer.sh
```

Stream the body to the private local CLI. It resolves the target repository
from `CLAUDE_PIPELINE_REPO` when set, otherwise from the current GitHub checkout:

```bash
{
  cat <<'EOF'
## Summary
...
EOF
  .claude/skills/report/footer.sh
} | .pipeline/toolkit/bin/pipeline cli tracker create-issue --title "<short summary>"
```

Before filing, search the open issue list for an obvious duplicate. If one
already covers the observation, add the missing context there instead of filing
a second issue.
