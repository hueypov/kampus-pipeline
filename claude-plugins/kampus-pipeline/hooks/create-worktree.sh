#!/usr/bin/env bash
# WorktreeCreate hook: make one isolated checkout for an agent without changing
# the consumer repository's primary checkout. It derives any remote/branch data
# from Git; it has no application, CI, package-manager, or hook-runner policy.

set -u

payload="$(cat)"

extract() {
	local key="$1"
	if command -v jq >/dev/null 2>&1; then
		printf '%s' "$payload" | jq -r --arg k "$key" '.[$k] // empty'
	else
		printf '%s' "$payload" \
			| grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
			| head -n1 \
			| sed -E "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/"
	fi
}

fail() {
	echo "pipeline worktree: $1" >&2
	exit 1
}

cwd="$(extract cwd)"
name="$(extract name)"

[ -n "$cwd" ] || fail "WorktreeCreate payload is missing cwd"
[ -n "$name" ] || fail "WorktreeCreate payload is missing name"
[ -d "$cwd" ] || fail "payload cwd '$cwd' is not accessible"

cd "$cwd" || fail "cannot enter payload cwd '$cwd'"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "payload cwd is not a Git worktree"

worktree_path="$cwd/.claude/worktrees/$name"
[ ! -e "$worktree_path" ] || fail "worktree path already exists: $worktree_path"
mkdir -p "$(dirname "$worktree_path")"

# Prefer a freshly-fetched upstream branch when the current branch has one. A
# local-only repository, detached checkout, or branch with no upstream remains
# supported: its current HEAD is a valid, explicit base.
base_ref="HEAD"
current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
upstream=""
if [ -n "$current_branch" ]; then
	upstream="$(git rev-parse --abbrev-ref --symbolic-full-name "${current_branch}@{upstream}" 2>/dev/null || true)"
fi

if [ -n "$upstream" ] && [[ "$upstream" == */* ]]; then
	remote="${upstream%%/*}"
	remote_branch="${upstream#*/}"
	git fetch --quiet "$remote" "$remote_branch" >&2 || fail "could not refresh upstream $upstream"
	base_ref="FETCH_HEAD"
else
	# A detached checkout has no branch upstream. If Git has recorded a remote's
	# default branch, use it; otherwise retain HEAD without guessing a branch name.
	remote="$(git remote | head -n1)"
	if [ -n "$remote" ]; then
		default_ref="$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)"
		if [ -n "$default_ref" ] && [[ "$default_ref" == "$remote/"* ]]; then
			remote_branch="${default_ref#"$remote/"}"
			git fetch --quiet "$remote" "$remote_branch" >&2 || fail "could not refresh remote default branch $default_ref"
			base_ref="FETCH_HEAD"
		fi
	fi
fi

git worktree add --detach "$worktree_path" "$base_ref" >&2 || fail "could not create isolated worktree"

# The consumer may use any submodules, including the pinned pipeline toolkit.
# Initialise what the repository itself declares; do not run a guessed project
# install command or assume a particular hook runner.
if [ -f "$cwd/.gitmodules" ]; then
	git -C "$worktree_path" submodule update --init --recursive >&2 || fail "could not initialize declared submodules"
fi

# Claude Code adopts stdout as the worktree path, so keep it machine-readable.
printf '%s\n' "$worktree_path"
