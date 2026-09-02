# Provenance

`multi-model-review` is a port of the bundled `/review` command in
[oh-my-pi](https://github.com/can1357/oh-my-pi) (npm
`@oh-my-pi/pi-coding-agent`) onto pi's own
`@earendil-works/pi-coding-agent` extension API, extended along exactly one
axis: every shard of the diff is reviewed independently by several different
model families, which then cross-check each other.

License: MIT, Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük,
(c) 2026 Stencil Labs, Inc. — see `LICENSE`.

**The pinned upstream version lives in `./UPSTREAM`.** Everything this
document calls verbatim is verified byte-for-byte by
`npm run check:upstream`, which re-downloads the pinned tarballs and diffs
them. The claims below are checkable, not aspirational.

## Verbatim upstream (never hand-edit these)

| File | From |
| --- | --- |
| `src/prompts/review-request.md` | `@oh-my-pi/pi-coding-agent` `src/prompts/review-request.md` |
| `src/prompts/review-custom-request.md` | same package, same path |
| `src/prompts/review-headless-request.md` | same package, same path |
| `vendor/prompt.ts` | `@oh-my-pi/pi-utils` `src/prompt.ts` |
| `vendor/template.ts` | `@oh-my-pi/pi-utils` `src/template.ts` |

The prompts are upstream's templates, rendered by upstream's own template
engine, so the review request an agent receives is upstream's text — including
its formatting quirks.

The renderer is vendored rather than depended on: `prompt.ts` imports only
`./template`, and `template.ts` imports nothing at all (it is a self-contained
handlebars reimplementation), whereas depending on the published
`@oh-my-pi/pi-utils` would pull `@oh-my-pi/pi-natives` — a native binary — into
a code-review extension.

`upstream-reference/reviewer.md` is also kept byte-identical and drift-checked,
but it is reference only: `agents/omp-reviewer.md` is adapted from it (see
below).

## Ported 1:1 (`src/review-core.ts`)

Structure, names, thresholds and heuristics are upstream's:

- the noise-file exclusion table, in upstream's order, with upstream's reasons;
- `parseDiff` per-file stats, including retained hunks;
- `getRecommendedAgentCount` — the diff-weight heuristic (1 → 16), which under
  the cross-product fan-out is the *shard* count and keeps its original meaning
  of "how finely should this diff be cut up";
- `getDiffPreview` and the per-file preview path for oversized diffs;
- `MAX_DIFF_CHARS` (50 000) and `MAX_FILES_FOR_INLINE_DIFF` (20);
- the full PR-reference layer: `pr://` and `https://github.com/.../pull/N`
  parsing, validation, argument extraction, and scanning conversation history
  for recently-mentioned PRs;
- merge-base pinning for base-branch reviews and PR-style semantics
  (committed work only): upstream 18.1.0 adopted merge-base pinning itself, so
  what an earlier version of this port listed as a deviation is now simply
  upstream behaviour;
- the interactive menu, its exact labels and its ordering, the
  detected-PR entries, and the rule that explicit instructions suppress the
  custom-instructions entry;
- the headless path, the jj working-copy path, and every warning/error string
  distinguishing "no changes" from "all changes filtered out".

## Upstream limitations preserved (deliberately not fixed)

One known upstream weakness is reproduced rather than repaired. It had a local
fix in an earlier draft of this port; that fix was reverted, because a port whose
*reviewed content* differs from upstream's is not a port, and "harmless local
improvement" is exactly how that divergence starts.

1. **Paths containing spaces.** `parseDiff` uses upstream's
   `^a/(.+?) b/(.+)` header match, which mis-splits `a/my file b/my file`. Such
   a file may be dropped from the review or given an unopenable path. Upstream's
   file-selection behaviour is reproduced exactly, including this.

   The consequence is contained rather than fixed: such a path is reconciled
   against git's own `--name-only -z` list and reported as an unreviewed gap
   (see deviation 4), so it is declared instead of silently vanishing. The parser
   itself is untouched.

## Deviations from upstream

Deviation 1 is UI-only — it changes how you *drive* the command, not what gets
reviewed, and exists because pi's dialog primitives are not omp's. Deviations 2
and 3 do change reviewed content, and say so; 4 and 5 change what the command
reports about its own coverage.

1. **Base-branch selection is a live-filtered, fixed-height list.** Upstream
   passes `listBranches(true)` — every local *and* remote-tracking ref —
   straight to a picker. pi's `ExtensionSelectorComponent` renders one row per
   option with no viewport and handles only up/down/confirm, so on a monorepo
   that is thousands of rendered rows and thousands of arrow presses. In a
   terminal this port instead shows its own component (`src/branch-picker.ts`)
   through `ctx.ui.custom`, built on pi-tui's `SelectList` with a 12-row
   viewport: type to filter live, arrows scroll, Enter selects, and each row is
   annotated `local · 2 hours ago` so recency is visible. Filtering is
   implemented in the component rather than via `SelectList.setFilter`, because
   that method matches with `startsWith` and branch names are structured
   (`release/prod-2025`), so a prefix match narrows nothing until you have typed
   the whole leading path. Non-terminal front ends (RPC has dialogs but no
   custom components) fall back to one input that doubles as an exact ref and a
   substring filter, then a bounded plain list.
2. **Base-branch review is the net parent → working-tree state.** This is the
   one deviation that changes reviewed content, and it is deliberate. Upstream
   compares committed state, which is right for a pushed PR and wrong for the
   common case of "review what I have right now": mid-change, the branch tip is
   a snapshot that no longer exists, so reviewers re-raise issues already fixed
   in the tree and miss every fix that is not committed yet — while their
   findings still read as authoritative. Reviewing deleted code is worse than
   reviewing nothing.

   The mechanism matters as much as the intent, and took three attempts.
   Concatenating `git diff base..HEAD` with the working-tree diff is wrong: it
   ships two patches for any file touched in both, including a committed hunk
   followed by its own reversal, so `parseDiff` emits that path twice with
   doubled stats. A single `git diff <merge-base>` fixes that but is still wrong,
   because `git diff` is index-aware: after `git rm --cached f` it reports `f` as
   deleted even though the file is on disk, losing any edits to it, and it omits
   untracked files entirely. Filtering synthetic additions against it cannot
   help — suppressing the duplicate leaves the false deletion standing.

   So the payload is built through a throwaway index: `git read-tree <base>`,
   `git add --all`, `git diff --cached <base>`. That is base → what is actually on
   disk in one patch — commits, staged, unstaged and brand-new files together,
   nothing to de-duplicate, and `GIT_INDEX_FILE` keeps the real index untouched.
   When the diff is too large to inline, seats are given the per-path
   reproduction of that same snapshot rather than a plain `git diff`, because the
   plain form misreports exactly these cases at exactly the moment no hunks are
   provided. With a clean tree the result is identical to upstream's `base..head`,
   mode string included. Use `/review <PR url>` when you want only what is pushed.
3. **New (untracked) files are reviewed.** This is the second deviation that
   changes reviewed content. Upstream reviews staged + unstaged only, so a file
   that has never been `git add`ed is invisible — and a brand-new file is usually
   the most important thing in a change. Requiring `git add` before a review tool
   will look at your code is a workflow tax with no upside.

   The mechanism is the temporary index described in deviation 2, not a separate
   synthesis step: `git read-tree <base>` then `git add --all` stages the entire
   worktree — additions, modifications and deletions alike — into a throwaway
   index, and one `git diff --cached <base>` produces the whole payload. Because
   there is exactly one diff, there is nothing to concatenate and no way for a
   path to appear twice with contradictory hunks (the `git rm --cached f` case,
   where `f` is untracked on disk while the tracked diff still reports it
   deleted, resolves itself for free). Staging also honours `.gitignore`, so
   build output does not flood the review.

   Before the first commit there is no `HEAD` to read, so the base becomes
   `read-tree --empty` plus a base-less `diff --cached` and every file reads as
   an addition. Deliberately not the well-known empty-tree hash
   `4b825dc6...`: that constant is sha1-only and a repository created with
   `--object-format=sha256` rejects it outright.
4. **Anything a reviewer will not actually read is reported.** Two sources, both
   otherwise silent: files with no reviewable hunk (a binary's chunk is a header
   plus `Binary files ... differ`, so counting it as covered yields a phantom
   table row), and files git reports as changed that the verbatim upstream parser
   cannot surface at all — git quotes hostile names in diff headers
   (``diff --git "a/we`ird\nname.bin" ...``), which upstream's `^a/(.+?) b/(.+)`
   regex does not match, so such a file would vanish from the table, the stats and
   the diff. Reconciling the parsed paths against git's own `--name-only -z` list
   turns that upstream limitation from a silent drop into a declared gap, without
   modifying the parser.

   Note what this is *not*: new files. Deviation 3 puts them in the diff, so they
   are reviewed, and reporting them as omitted would be a false alarm. What is
   reported is the residue no reviewer can read whatever its tracking status —
   binaries and unparseable paths. Renames and mode-only changes are excluded
   too: git describes those completely without a `@@` hunk, so flagging them
   would cry wolf on every refactor that moves a file. The gap is
   stated both in the terminal and — critically — **in the prompt itself**, since
   the prompt is the only thing reviewers and the synthesising agent ever read: a
   review covering part of a change would otherwise report as if it covered all
   of it, with nothing in the artifact able to contradict that. Paths are rendered
   with `JSON.stringify`, not wrapped in backticks, because git filenames are
   arbitrary bytes: a name containing a newline or a backtick would otherwise
   break out of its list item or read as further instructions to the agent.
5. **Oversized diffs are refused with numbers.** Diffs are sized with
   `--shortstat` before being fetched, so a base branch that forked long ago
   produces "4,300 files and 1,200,000 changed lines, past this command's
   ceiling" instead of a bare `spawnSync git ENOBUFS` from inside
   `execFileSync`.
6. **The user's git configuration is neutralised, not inherited.** Every diff is
   produced with `--no-ext-diff --no-color --no-relative --submodule=short
   --src-prefix=a/ --dst-prefix=b/`, the child environment pins `LC_ALL=C`, and
   status probes pass `-uall`. This is a deviation only in the sense that
   upstream's native VCS module does not need it; the *reviewed content* is what
   upstream would produce under default configuration.

   It is here because the verbatim parser is not ours to loosen. `parseDiff`
   matches `diff --git a/<path> b/<path>` exactly, so `diff.noprefix`,
   `diff.mnemonicPrefix`, `color.ui=always` and `diff.external` each made every
   header unparseable and aborted the review with "all changes filtered out" — a
   total failure whose cause was invisible from the message. `diff.relative`
   narrowed the review to the current directory, `diff.submodule=log` removed the
   header for submodule bumps, `status.showUntrackedFiles=no` made a
   new-files-only tree report as clean, and a localized git broke the
   `N files changed` regexes that enforce the size ceiling. The scope flags go on
   the size probe and the path list as well as the payload, because
   `coverageGaps` compares those against each other and a disagreement invents
   or hides gaps. The command a reviewer is handed to reproduce the snapshot
   carries the same flags, since seats run it under the same configuration.

## Forced adaptations (pi has no equivalent)

- **VCS layer** (`src/vcs.ts`). Upstream 18.1.0 calls
  `@oh-my-pi/pi-natives/vcs`, a native module that cannot be vendored into a pi
  extension, so this reimplements the surface the review command uses over
  `git`/`jj`/`gh` subprocesses, matching upstream's error posture (swallow to
  empty where upstream swallows, throw where upstream throws).
- **Two prompt sections** (`src/overrides.ts`). The templates stay verbatim on
  disk; two sections are replaced at load time because they name omp machinery
  that does not exist here — the `task` tool with a `tasks` array, and
  incremental `yield` findings sections. Both ends of each replaced range are
  explicit anchors, asserted at load time and by the drift check, so an
  upstream rename fails loudly instead of silently shipping instructions for a
  tool pi does not have.
- **The reviewer agent** (`agents/omp-reviewer.md`). Adapted from upstream's
  `reviewer.md`: the procedure, criteria, cross-boundary check, priority table
  and finding shape are upstream's. Four things could not come across —
  the name (pi-subagents ships a *builtin* `reviewer` that may edit files, so
  reusing the name risks losing a precedence coin toss to an agent with write
  tools), `model: "@slow"` (no such alias, and the panel assigns models per
  seat), `spawns: scout` plus the `lsp`/`ast_grep` tools (no pi equivalents),
  and the typed `output:` schema with its `yield` findings channel (pi
  subagents return one final message, so the finding format is specified as
  text). omp's live P0–P3 findings UI has no pi counterpart.

## Original to this project

**Defaults are upstream.** `/review` with no config is upstream's flow: one
model, one pass, upstream's shard count, upstream's wording — and no
confirmation prompt, since upstream has none and its heuristic can recommend 16
shards on a large diff. Everything below is opt-in, which is the only arrangement
under which "faithful port" is a promise rather than a description of one code
path. The confirmation threshold applies only to runs this package multiplies:
`families > 1`, or `crossCheck` doubling the invocations. An explicit
`shardDepth` is the user's own number and is not second-guessed.

- **The cross-product fan-out (opt-in).** Upstream shards files by locality across N
  copies of one model. This runs each shard on K distinct model families
  (`N × K` reviewers), cross-checks *within* each shard, and synthesises one
  verdict. Upstream's axis is untouched: the shard count is upstream's
  `getRecommendedAgentCount` verbatim and is never adjusted. `confirmAboveRuns`
  is a confirmation threshold, not a cap — a large fan-out is surfaced to the
  user before launch instead of the code quietly redefining N or K. (An earlier
  draft shrank the shard count to fit a ceiling; that silently replaced
  upstream's sharding decision with ours and was removed.)
- **Per-session model discovery** (`src/panel.ts`). Nothing in this package
  names a model. The candidate list is read from the session's own registry (or
  its scoped subset) at review time and auth-filtered, because hardcoded model
  names go stale and travel badly between machines.
- **Panel rules** (`~/.pi/agent/multi-model-review/config.json`): `families`
  (K), `shardDepth` (N, `"auto"` = upstream's heuristic), `crossCheck`,
  `confirmAboveRuns`, `exclude` globs. Defaults reproduce upstream exactly;
  renamed fields fail loudly rather than silently meaning something else. No file means defaults; a
  malformed saved file blocks the review with an actionable error rather than
  silently launching a different panel.
- **The `workflowScript` skeleton** in the distribution section, including the
  `runs.all`-returns-an-array lookup that earlier versions of this recipe got
  wrong twice, independently, in the same way.
- All packaging, tests and the drift check.

## `/review-multi-modal`

A second command, entirely this project's own: every reachable model family
reviews the whole diff (no sharding), plus persona seats on the cheapest
families, single pass, synthesised by the parent. It shares `/review`'s verbatim
upstream request template, diff snapshot, size ceiling and coverage disclosures;
only the distribution section differs. The four reviewer personas live here
rather than in `/review`, which keeps `/review` a clean superset of upstream.

## Retired

v0.2.0's seat-based config (`seats`, per-seat model pins, `pass1Only`) is gone.
An old config is detected and blocks with an explanation pointing at
`/review-multi-modal`, rather than being silently ignored. The personas
themselves are not retired — they moved to `/review-multi-modal`, restored from
`ce39a51`.
