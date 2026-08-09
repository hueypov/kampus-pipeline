#!/usr/bin/env bash
# Open a new `wayfinder:map` issue. Prints the new map's issue NUMBER on stdout.
#
# usage: create-map.sh "<destination, as a short noun phrase>" < body.md
#
# REST only — issue operations do not use GraphQL.
#
# The body arrives on STDIN, and an EMPTY stdin is REFUSED: the map body is authored prose, so it is
# an external input to this script. An unread pipe is byte-identical to an empty one, and filing on
# it would open a bodyless map that reads as a successful chart — hence the fail-closed guard.
#
# Shell options are `set -uo pipefail`, deliberately NOT `-e`: this script steers its own control
# flow, and `errexit` would abort a fail-closed branch before it printed its refusal.
set -uo pipefail

[ "$#" -ge 1 ] || {
	echo "wayfinder: create-map.sh needs a destination title — NO map was created." >&2
	echo "usage: create-map.sh \"<destination>\" < body.md" >&2
	exit 2
}
TITLE="$1"
[ -n "$TITLE" ] || {
	echo "wayfinder: empty destination title — NO map was created." >&2
	exit 2
}

REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
[ -n "$REPO" ] || {
	echo "wayfinder: target repo unresolved — NO map was created." >&2
	exit 1
}

BODY="$(cat)"
[ -n "$BODY" ] || {
	echo "wayfinder: stdin was empty — refusing to open a BODYLESS map. NO map was created." >&2
	exit 3
}

MAP=$(gh api -X POST "repos/$REPO/issues" \
	-f title="$TITLE" \
	-f "labels[]=wayfinder:map" \
	-f body="$BODY" --jq '.number')
[ -n "$MAP" ] || {
	echo "wayfinder: the create call returned no issue number — the map may or may not exist; check before retrying." >&2
	exit 1
}

printf '%s\n' "$MAP"
