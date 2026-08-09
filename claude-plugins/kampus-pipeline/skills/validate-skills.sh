#!/usr/bin/env bash
# Validate the skill payload on two axes.
#
# 1. Frontmatter, over `*/SKILL.md`: the file opens with a `---` fence and carries a non-empty
#    `name` matching its directory plus a non-empty `description`. The `description` is what the
#    harness routes on, so a malformed one silently makes a skill unroutable.
#
# 2. References, over every `*.md` under this directory, recursively: link targets that are prose
#    rather than a path, `#fragment`s that resolve to no heading in the target document, and known
#    text-substitution residue. Frontmatter validity certifies that a skill is *routable*; it says
#    nothing about whether the body still points at anything real, which is how this payload came
#    to carry hundreds of unresolvable references under a green validator (#167).
#
# The two axes deliberately differ in scope. Half the reference damage lives in files no
# `*/SKILL.md` glob reaches: shared contracts sitting directly in this directory, and the contract
# documents under `shared/`, which has no `SKILL.md` at all. A reference check that inherited the
# frontmatter glob would certify clean while skipping the most-cited damaged document.
#
# Run locally, or from CI: `.github/workflows/ci.yml` invokes this in its build job.
#
# Reference findings are gated against a repository-owned baseline (`--write-baseline` prints
# where). Damage predating the check stays visible without reddening every build, while anything
# new fails from its first commit. The baseline can only shrink: nothing writes to it but an
# explicit `--write-baseline`, an entry that no longer reproduces is reported and does not fail,
# and an absent baseline suppresses nothing rather than skipping the check.
set -euo pipefail

mode=check
while [ $# -gt 0 ]; do
	case "$1" in
		--write-baseline) mode=write ;;
		--list-files) mode=list ;;
		-h | --help)
			echo "usage: validate-skills.sh [--write-baseline | --list-files]"
			exit 0
			;;
		*)
			echo "validate-skills: unknown argument '$1'" >&2
			exit 2
			;;
	esac
	shift
done

# This script sits at the root of the skill tree, so its own directory IS the skills root —
# resolve from BASH_SOURCE so it works from any cwd (local shell or CI runner).
skills_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Findings are reported and keyed by repository-relative path, so a baseline written on one
# machine matches on another. Fall back to the skills root when there is no enclosing repository,
# which keeps a throwaway fixture tree self-consistent between writing and reading a baseline.
repo_root="$(cd "$skills_dir" && git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$repo_root" ] || repo_root="$skills_dir"

# Repository-owned data, not shipped policy: an adopting repository starts with no baseline, and
# no baseline means no suppressions.
baseline="${VALIDATE_SKILLS_BASELINE:-$repo_root/.pipeline/validate-skills-baseline.tsv}"

md_list="$(find "$skills_dir" -type f -name '*.md' | LC_ALL=C sort)"

if [ "$mode" = list ]; then
	printf '%s\n' "$md_list" | while IFS= read -r md; do
		if [ -n "$md" ]; then printf '%s\n' "${md#"$repo_root"/}"; fi
	done
	exit 0
fi

read -r -d '' reference_checks <<'AWK' || true
function trim(s) {
	sub(/^[ \t\r]+/, "", s)
	sub(/[ \t\r]+$/, "", s)
	return s
}

function norm(s) {
	gsub(/[ \t\r]+/, " ", s)
	return trim(s)
}

function relative(path) {
	return (index(path, root) == 1) ? substr(path, length(root) + 1) : path
}

function directory(path,  cut, i) {
	cut = 0
	for (i = length(path); i > 0; i--)
		if (substr(path, i, 1) == "/") { cut = i; break }
	return (cut > 1) ? substr(path, 1, cut - 1) : "/"
}

function countocc(hay, needle,  n, p) {
	n = 0
	while ((p = index(hay, needle)) > 0) {
		n++
		hay = substr(hay, p + length(needle))
	}
	return n
}

# GitHub's heading-anchor slug: drop link targets and emphasis, lowercase, delete everything that
# is neither alphanumeric nor space, underscore or hyphen, then spaces become hyphens. Repeats of
# the same slug within one document take a `-1`, `-2` suffix in document order.
function slug(text,  s, i, n) {
	s = text
	sub(/[ \t]*#+[ \t]*$/, "", s)
	while ((i = index(s, "](")) > 0) {
		n = index(substr(s, i + 1), ")")
		if (n == 0) break
		s = substr(s, 1, i) substr(s, i + n + 1)
	}
	gsub(/[][]/, "", s)
	s = tolower(s)
	gsub(/[^a-z0-9 _-]/, "", s)
	s = trim(s)
	gsub(/ /, "-", s)
	return s
}

# Headings, unlike links, must skip fenced blocks or a `# comment` in a shell sample registers as
# a heading. That would not merely add a bogus anchor: it would shift the duplicate-suffix
# numbering of every later heading, so real anchors would stop resolving.
function build(f,  line, lineno, fence, front, text, s, key, dupes, r) {
	if (f in indexed) return
	indexed[f] = 1
	lineno = 0
	fence = 0
	front = 0
	while ((r = (getline line < f)) > 0) {
		sub(/\r$/, "", line)
		lineno++
		if (lineno == 1 && line ~ /^---[ \t]*$/) { front = 1; continue }
		if (front) {
			if (line ~ /^---[ \t]*$/) front = 0
			continue
		}
		if (line ~ /^[ \t]*(```|~~~)/) { fence = 1 - fence; continue }
		if (fence) continue
		if (line !~ /^#+[ \t]/) continue
		text = line
		sub(/^#+[ \t]+/, "", text)
		s = slug(text)
		if (s == "") continue
		key = f SUBSEP s
		if (dupes[key]++ > 0) s = s "-" (dupes[key] - 1)
		anchor[f SUBSEP s] = 1
	}
	close(f)
	if (r < 0) unreadable[f] = 1
}

function resolve(dir, rel,  parts, out, n, i, k, path) {
	path = (substr(rel, 1, 1) == "/") ? rel : dir "/" rel
	n = split(path, parts, "/")
	k = 0
	for (i = 1; i <= n; i++) {
		if (parts[i] == "" || parts[i] == ".") continue
		if (parts[i] == "..") {
			if (k > 0) k--
			continue
		}
		out[++k] = parts[i]
	}
	path = ""
	for (i = 1; i <= k; i++) path = path "/" out[i]
	return path
}

function record(check, file, text, lineno, n, message,  k) {
	k = check SUBSEP file SUBSEP text
	if (!(k in found)) {
		found[k] = 1
		order[++norder] = k
		fcheck[k] = check
		ffile[k] = file
		ftext[k] = text
		fline[k] = lineno
		fmessage[k] = message
	}
	occurrences[k] += n
	total[check] += n
}

function link(f, rel, dir, lineno, target,  t, hash, path, frag, tgt) {
	t = trim(target)
	if (t == "" || t ~ /^https?:/ || t ~ /^mailto:/) return
	# Check 1. A target carrying a space is prose left where an href belonged. It is not a path,
	# so it is not worth resolving further -- check 2 would only restate the same damage.
	if (t ~ /[ \t]/) {
		record("prose-href", rel, norm(t), lineno, 1, "link target is prose, not a path")
		return
	}
	# Check 2. The fragment is the part substitution destroys while leaving the path intact, so a
	# link check that stops at file existence passes the exact damage this is aimed at.
	hash = index(t, "#")
	if (hash == 0) return
	path = substr(t, 1, hash - 1)
	frag = substr(t, hash + 1)
	if (frag == "") return
	tgt = (path == "") ? f : resolve(dir, path)
	build(tgt)
	if (tgt in unreadable) {
		record("anchor", rel, t, lineno, 1, "link fragment unresolvable: target document does not exist")
		return
	}
	if (!((tgt SUBSEP frag) in anchor))
		record("anchor", rel, t, lineno, 1, "link fragment matches no heading in the target document")
}

function scan(f,  rel, dir, lineno, fence, line, low, i, j, n, rest, tail, target) {
	# Index this document's own headings before reading it for findings, never during. `getline <
	# file` keeps one read position per filename, so resolving a same-document `#fragment` mid-scan
	# would consume the scan's own stream and then close it, silently re-reading the file from the
	# top: doubled phrase counts, wrong line numbers, and a heading index holding only the part of
	# the document that happened to remain unread.
	build(f)
	rel = relative(f)
	dir = directory(f)
	lineno = 0
	fence = 0
	while ((getline line < f) > 0) {
		sub(/\r$/, "", line)
		lineno++
		low = tolower(line)
		# Check 3. Residue is scanned inside fenced blocks too: a substituted phrase in a fenced
		# template is prose an agent copies out verbatim, where link *syntax* in a fence is a code
		# sample and resolving it would flag every shell snippet that prints a `](...)` pattern.
		for (i = 1; i <= nphrase; i++) {
			n = countocc(low, lowered[i])
			if (n > 0) record("phrase", rel, phrase[i], lineno, n, "text-substitution residue")
		}
		if (line ~ /^[ \t]*(```|~~~)/) { fence = 1 - fence; continue }
		if (fence) continue
		rest = line
		while ((i = index(rest, "](")) > 0) {
			tail = substr(rest, i + 2)
			j = index(tail, ")")
			if (j == 0) break
			target = substr(tail, 1, j - 1)
			rest = substr(tail, j + 1)
			link(f, rel, dir, lineno, target)
		}
	}
	close(f)
	scanned++
}

BEGIN {
	nphrase = split("repository precedent|the applicable safety invariant|repository-owned record URL|repository decision record", phrase, "|")
	for (i = 1; i <= nphrase; i++) lowered[i] = tolower(phrase[i])
	nbase = 0
	while ((getline entry < baseline) > 0) {
		sub(/\r$/, "", entry)
		if (entry ~ /^[ \t]*#/ || trim(entry) == "") continue
		if (split(entry, field, "\t") < 3) continue
		key = field[1] SUBSEP field[2] SUBSEP field[3]
		if (key in baselined) continue
		baselined[key] = 1
		border[++nbase] = key
		bcheck[key] = field[1]
		bfile[key] = field[2]
		btext[key] = field[3]
	}
	close(baseline)
}

{ if (trim($0) != "") scan(trim($0)) }

END {
	if (mode == "write") {
		for (i = 1; i <= norder; i++) {
			k = order[i]
			printf "%s\t%s\t%s\n", fcheck[k], ffile[k], ftext[k]
		}
		exit 0
	}

	fresh = 0
	suppressed = 0
	for (i = 1; i <= norder; i++) {
		k = order[i]
		if (k in baselined) {
			hit[k] = 1
			suppressed++
			continue
		}
		fresh++
		printf "FAIL %s:%d: %s: %s (%s)", ffile[k], fline[k], fcheck[k], fmessage[k], ftext[k]
		if (occurrences[k] > 1) printf " [%d occurrences in this file]", occurrences[k]
		printf "\n"
	}

	resolved = 0
	for (i = 1; i <= nbase; i++) {
		k = border[i]
		if (k in hit) continue
		resolved++
		printf "RESOLVED %s: %s: %s no longer reproduces; drop this line from the baseline\n", bfile[k], bcheck[k], btext[k]
	}

	printf "validate-skills: references: scanned %d markdown file(s); %d finding(s) [%d new, %d baselined], %d baseline entr%s resolved\n",
		scanned, norder, fresh, suppressed, resolved, (resolved == 1 ? "y" : "ies")
	printf "validate-skills: occurrences by check: prose-href=%d anchor=%d phrase=%d\n",
		total["prose-href"] + 0, total["anchor"] + 0, total["phrase"] + 0
	if (fresh > 0) exit 1
}
AWK

if [ "$mode" = write ]; then
	mkdir -p "$(dirname "$baseline")"
	draft="$(mktemp "$baseline.XXXXXX")"
	{
		cat <<-'HEADER'
			# validate-skills reference-check baseline.
			#
			# Every line is one suppressed finding, TAB-separated: check id, repository-relative
			# file, matched text. Deliberately no counts and no line numbers. A count lets a new
			# violation in one file hide behind a repaired one in another, which is the false green
			# this baseline exists to prevent; a line number would churn every entry whenever an
			# unrelated edit shifts the lines above it, and a baseline that reds unrelated pull
			# requests is a baseline somebody deletes.
			#
			# The residual cost of that key: a second occurrence of an already-listed phrase in an
			# already-listed file is suppressed. The run reports occurrence counts per check so the
			# drawdown stays measurable even though it is not what the build gates on.
			#
			# Entries are only ever removed. Regenerate wholesale with
			# `claude-plugins/kampus-pipeline/skills/validate-skills.sh --write-baseline` -- but a
			# regeneration re-suppresses whatever was failing, so it is a deliberate act, not a fix.
		HEADER
		printf '%s\n' "$md_list" | awk -v root="$repo_root/" -v baseline="$baseline" -v mode=write "$reference_checks" | LC_ALL=C sort -u
	} >"$draft"
	mv "$draft" "$baseline"
	echo "validate-skills: wrote baseline ${baseline#"$repo_root"/}"
	exit 0
fi

shopt -s nullglob
errors=0
count=0

strip() { # trim surrounding whitespace then surrounding quotes
	local s="$1"
	s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
	s="${s#[\"\']}"; s="${s%[\"\']}"
	printf '%s' "$s"
}

for skill_md in "$skills_dir"/*/SKILL.md; do
	count=$((count + 1))
	rel="${skill_md#"$repo_root"/}"
	dir_name="$(basename "$(dirname "$skill_md")")"

	if [ "$(head -n1 "$skill_md")" != "---" ]; then
		echo "FAIL $rel: missing opening '---' frontmatter fence on line 1"
		errors=$((errors + 1))
		continue
	fi

	# frontmatter = lines between the first two '---' fences
	frontmatter="$(awk 'NR==1{next} /^---[[:space:]]*$/{exit} {print}' "$skill_md")"
	if [ -z "$frontmatter" ]; then
		echo "FAIL $rel: empty or unterminated frontmatter block"
		errors=$((errors + 1))
		continue
	fi

	name="$(strip "$(printf '%s\n' "$frontmatter" | sed -n 's/^name:[[:space:]]*//p' | head -n1)")"
	desc="$(strip "$(printf '%s\n' "$frontmatter" | sed -n 's/^description:[[:space:]]*//p' | head -n1)")"

	if [ -z "$name" ]; then
		echo "FAIL $rel: frontmatter missing non-empty 'name'"
		errors=$((errors + 1))
	elif [ "$name" != "$dir_name" ]; then
		echo "FAIL $rel: name '$name' does not match directory '$dir_name'"
		errors=$((errors + 1))
	fi

	if [ -z "$desc" ]; then
		echo "FAIL $rel: frontmatter missing non-empty 'description'"
		errors=$((errors + 1))
	fi
done

if [ "$count" -eq 0 ]; then
	echo "FAIL: no */SKILL.md found under ${skills_dir#"$repo_root"/} (check the path)"
	exit 1
fi

references=0
printf '%s\n' "$md_list" | awk -v root="$repo_root/" -v baseline="$baseline" -v mode=check "$reference_checks" || references=$?

if [ "$errors" -gt 0 ] || [ "$references" -ne 0 ]; then
	echo "validate-skills: FAILED -- $errors frontmatter error(s) across $count skill(s)"
	exit 1
fi

echo "validate-skills: OK -- $count skills valid"
