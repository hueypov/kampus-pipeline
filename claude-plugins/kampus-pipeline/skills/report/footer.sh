#!/usr/bin/env bash
set -euo pipefail

parts=("Filed by an agent")
session="${CLAUDE_CODE_SESSION_ID:-}"
if [[ -n "$session" ]]; then parts+=("session \`${session}\`"); fi
model="${ANTHROPIC_MODEL:-${CLAUDE_MODEL:-}}"
if [[ -n "$model" ]]; then parts+=("model \`${model}\`"); fi
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -n "$branch" && "$branch" != "HEAD" ]]; then parts+=("branch \`${branch}\`"); fi
parts+=("$(date -u +"%Y-%m-%dT%H:%M:%SZ")")
printf -- '---\n<sub>%s</sub>\n' "$(IFS=' · '; echo "${parts[*]}")"
