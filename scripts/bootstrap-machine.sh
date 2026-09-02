#!/usr/bin/env bash
# Make this machine run multi-model-review from a local, editable checkout.
#
# Why not `pi install npm:` or `pi install git:`? Because both give you a
# pi-managed copy you must not edit: the git updater runs `git reset --hard` and
# `git clean -fdx` inside its clone, so local changes are destroyed on update, and
# npm means a publish round-trip for every change. A local-path package entry
# instead points pi at a checkout you own.
#
# The settings entry is `../../git/multi-model-review`, resolved by pi against
# ~/.pi/agent, i.e. $HOME/git/multi-model-review. That is home-relative, so the SAME
# entry works on every machine — which is what lets a synced settings.json carry
# this install everywhere without naming any one machine's paths.
#
# Idempotent: safe to re-run. Updates an existing checkout instead of clobbering.
#
#   curl -fsSL <raw-url>/scripts/bootstrap-machine.sh | bash
#   # or, from an existing checkout:
#   ./scripts/bootstrap-machine.sh

set -euo pipefail

REPO_URL="${MULTI_MODEL_REVIEW_REPO_URL:-https://github.com/Scott-Meyer/multi-model-review.git}"
CHECKOUT="${MULTI_MODEL_REVIEW_CHECKOUT:-$HOME/git/multi-model-review}"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$AGENT_DIR/settings.json"
AGENTS_DIR="$AGENT_DIR/agents"
# Must stay relative so one synced settings.json works on every machine.
ENTRY="../../git/multi-model-review"

info() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }

command -v git >/dev/null || { echo "bootstrap: git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "bootstrap: node is required (pi needs >=22.19)" >&2; exit 1; }

echo "==> checkout at $CHECKOUT"
if [ -d "$CHECKOUT/.git" ]; then
  info "already a git checkout; fetching"
  git -C "$CHECKOUT" fetch --quiet --tags origin
  if [ -n "$(git -C "$CHECKOUT" status --porcelain)" ]; then
    info "local changes present — NOT touching them (skipping fast-forward)"
  else
    branch="$(git -C "$CHECKOUT" symbolic-ref --quiet --short HEAD || echo)"
    if [ -n "$branch" ] && git -C "$CHECKOUT" rev-parse --quiet --verify "origin/$branch" >/dev/null; then
      git -C "$CHECKOUT" merge --ff-only --quiet "origin/$branch" && info "fast-forwarded $branch"
    else
      info "detached or no upstream branch; leaving HEAD alone"
    fi
  fi
elif [ -e "$CHECKOUT" ]; then
  echo "bootstrap: $CHECKOUT exists but is not a git checkout; move it aside first" >&2
  exit 1
else
  mkdir -p "$(dirname "$CHECKOUT")"
  git clone --quiet "$REPO_URL" "$CHECKOUT"
  info "cloned"
fi

echo "==> pi settings"
mkdir -p "$AGENT_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
ENTRY="$ENTRY" SETTINGS="$SETTINGS" node -e '
const fs = require("node:fs");
const file = process.env.SETTINGS, entry = process.env.ENTRY;
let settings;
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
} catch (err) {
  console.error(`  refusing to edit ${file}: ${err.message}`);
  console.error(`  add "${entry}" to its "packages" array by hand.`);
  process.exit(1);
}
const packages = Array.isArray(settings.packages) ? settings.packages : [];
const has = packages.some(p => (typeof p === "string" ? p : p && p.source) === entry);
// A git/npm spec for this same project would load a SECOND copy: pi keys package
// identity separately for local paths vs git URLs vs npm names, so both would
// register /review and conflict.
const rival = packages.filter(p => {
  const s = typeof p === "string" ? p : p && p.source;
  return typeof s === "string" && s !== entry && /multi-model-review/.test(s);
});
if (rival.length) {
  console.error(`  WARNING: other multi-model-review entries present: ${rival.join(", ")}`);
  console.error("  remove them, or you will load the extension twice and conflict on /review.");
}
if (has) {
  console.log("  entry already present");
} else {
  packages.push(entry);
  settings.packages = packages;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  added "${entry}" to packages`);
}
'

echo "==> reviewer agents"
# Nothing to copy. The agents ship inside the package and pi-subagents discovers
# them from the manifest (pi.subagents.agents), so a plain install is enough.
# Copying them into ~/.pi would create user-scope duplicates that shadow the
# package copies and then silently go stale on every update.
info "bundled with the package — no copy needed (pi.subagents.agents)"
if [ -d "$AGENTS_DIR" ]; then
  stale=""
  for f in "$CHECKOUT"/agents/*.md; do
    name="$(basename "$f")"
    [ -f "$AGENTS_DIR/$name" ] && stale="$stale $name"
  done
  if [ -n "$stale" ]; then
    info "note: older hand-copied versions exist in $AGENTS_DIR and will SHADOW the package:$stale"
    info "      delete them to track package updates, or keep them if you customised them"
  fi
fi

echo "==> done"
info "restart pi, then run /review in any git repo"
info "edit code directly in $CHECKOUT — it is the live install"
