# multi-model-review

A faithful port of [oh-my-pi](https://github.com/can1357/oh-my-pi)'s bundled
`/review` command onto [pi](https://github.com/earendil-works/pi) — verbatim
upstream prompts, diff logic and heuristics — extended along exactly one axis:
**every shard of the diff is reviewed by several different model families,
which then cross-check each other.**

> Not affiliated with, endorsed by, or supported by oh-my-pi / Stencil Labs,
> Inc., or by the pi project / Earendil Works.

"Faithful" here is a checkable claim, not a compliment we paid ourselves:
`npm run check:upstream` re-downloads the pinned upstream tarballs and fails if
any verbatim file has drifted in either direction. See `PROVENANCE.md` for the
file-by-file breakdown, `./UPSTREAM` for the pin.

## What it does

Run `/review` in a git (or jj) repo and pick a mode — upstream's menu, in
upstream's order:

1. **Review against a base branch** (PR style) — the merge base against your
   current branch, so commits that exist only on the base are excluded.
   **Uncommitted work and brand-new files are included** — the review is the net
   `base` → *what is on disk* state, built through a throwaway git index so it is
   accurate even for files you have `git rm --cached`ed. Mid-change, a
   committed-only diff reviews a snapshot that no longer exists: a change you
   committed and then reverted does not appear at all. No `git add` required. Use
   `/review <PR url>` when you want only what is pushed.

   Choosing the base is a filtered, fixed-height list — type to narrow it live:

   ```
   Base branch for `feature`
     filter: prod  (2 of 247)

   → release/prod-2025                remote · 3 hours ago
     release/prod-2024                local  · 6 months ago

     ↑↓ move · type to filter · ⌫ delete · ctrl+u clear · enter select · esc cancel
   ```

   Twelve rows at a time regardless of how many branches you have, matched by
   substring anywhere in the name, local and remote, newest first. Outside a
   terminal it degrades to one prompt that accepts an exact ref or a filter.

2. **Review uncommitted changes** — staged + unstaged + brand-new files. You do
   not need to `git add` anything first; new files are synthesised into the diff
   as additions. Anything git cannot diff as text (binaries) is named in the
   review request as an explicit coverage gap.
3. **Review a specific commit** — picked from your last 20.
4. **Custom review instructions.**

Plus: pass a GitHub PR URL (`/review https://github.com/o/r/pull/42`) to review
that PR directly, and PRs mentioned earlier in the conversation appear at the
top of the menu automatically.

Lock files, minified/generated code, build output, vendor dirs, images, fonts
and binaries are stripped before reviewers see the diff.

## Cost, first

Model invocations are `shardDepth × families`, **doubled when `crossCheck` is on**
because every surviving seat is resumed for the second pass. Everything else in
this README is downstream of that arithmetic.

| what you want | config | invocations (N = upstream's shard count) |
| --- | --- | --- |
| **omp parity** (default, cheapest) | none | N — one model, one pass, same as omp |
| a second opinion everywhere | `{"families": 2}` | 2N |
| three-way, no cross-examination | `{"families": 3}` | 3N |
| adversarial cross-examination | `{"families": 3, "crossCheck": true}` | **6N** |
| every family + personas | `/review-multi-modal` | families + persona seats, one pass |

`confirmAboveRuns` (default 12) is the guard, and it is compared against the
*doubled* figure — so a 3×3 cross-checked run reports "up to 18 model
invocations" and asks, rather than quietly counting 9 seats. It never silently
reduces N or K (either would change what gets reviewed), and it never fires on a
default run, because upstream never pauses.

## Two commands

### `/review` — upstream's review, by default exactly

With no config, `/review` is omp's `/review`: files split across reviewer
subagents by upstream's diff-weight heuristic, **one model, one pass**, one
synthesised verdict. The rendered prompt is upstream's own wording, with `task`
→ `subagent` because that is pi's tool. Nothing about a default run is this
package's invention.

The multi-model panel is opt-in, via `/review config`:

```json
{
	"families": 1,
	"shardDepth": "auto",
	"crossCheck": false,
	"confirmAboveRuns": 12,
	"exclude": []
}
```

- **`families`** (1–8) — **K**: how many distinct model families review *each*
  shard. `1` is upstream. Raise it and every shard gets read independently by
  different lineages, so a bug one family is blind to has K chances to be caught.
- **`shardDepth`** (`"auto"` or 1–32) — **N**: how finely to fork the files.
  `"auto"` is upstream's heuristic (1 → 16 by diff weight); a number overrides it
  and the prompt says so.
- **`crossCheck`** — a second pass where each seat re-examines its peers'
  write-ups against the real code. Off by default; upstream has no second pass.
  Requires `families` ≥ 2.
- **`confirmAboveRuns`** — when planned **invocations** exceed this, `/review`
  states the arithmetic and asks before launching. Planned invocations are
  `N × K`, **doubled when `crossCheck` is on** (each seat is resumed for the
  second pass) — so set this against the doubled figure, not the seat count. A
  threshold, not a cap: it never silently reduces N or K, because either would
  change what gets reviewed. It applies only once you have opted in: a default
  run never pauses, because upstream never does, and upstream's own heuristic can
  recommend 16 shards on a large diff.
- **`exclude`** — globs against `provider/model-id` to shrink the candidate pool.

Total reviewers is `N × K`, and planned *invocations* are that doubled when
`crossCheck` is on. Nothing in the package names a model: candidates are read
from your session's registry at review time and auth-filtered.

### `/review-multi-modal` — the panel

Every model family your session can reach reviews the **whole** diff — no
sharding — plus extra persona seats (`reviewer-linus`, `reviewer-danluu`,
`reviewer-antagonist`) on the cheapest families. One pass, all results back to
the main agent for synthesis.

Because every seat is independent and no seat reads another's write-up,
agreement counts mean exactly what they say: convergence between different
lineages is uncontaminated corroboration, which is far better evidence than any
single model's self-reported confidence.

The extension cannot see prices — the registry exposes provider, id and name
only — so the agent picks which families are cheap and must say which it chose,
letting you correct it. No stale price table ships here.

## Install

**Editable checkout** (recommended if you intend to modify it — the checkout
*is* the install, so edits are live and updates are `git pull`):

```bash
curl -fsSL https://raw.githubusercontent.com/Scott-Meyer/multi-model-review/main/scripts/bootstrap-machine.sh | bash
```

That clones to `$HOME/git/multi-model-review` and registers it as a local-path
package in `~/.pi/agent/settings.json`.

**Or as a managed pi package:**

```bash
pi install npm:multi-model-review
```

**Or add it to `packages` in `~/.pi/agent/settings.json`** (paths resolve
relative to the agent dir):

```json
{ "packages": ["../../git/multi-model-review"] }
```

Requires [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) (the panel
runs through its `subagent` tool) and Node **22.19+**, matching pi itself.

## Reviewer agents — nothing to install by hand

The five reviewer agents ship *inside* the package and are discovered
automatically, because the manifest exposes them to `pi-subagents`:

```json
{ "pi": { "subagents": { "agents": ["./agents"] } } }
```

So `pi install npm:multi-model-review` is sufficient: **no manual file copying
and no hand-placed files**, which matters for CI where no one is around to run a
copy step. (`pi install` does of course write the package under `~/.pi`, and
`/review config` saves there if you use it — the point is that you never have to
put a file anywhere yourself.)
`/review` uses `omp-reviewer`; `/review-multi-modal` also uses
`reviewer-primary`, `reviewer-linus`, `reviewer-danluu` and
`reviewer-antagonist`.

Package agents sit *above* pi's builtins and *below* your own, so a same-named
file in `~/.pi/agent/agents/` or your project's `agents/` still wins — customise
by shadowing, and your copy is never clobbered by an update. `npm run
verify:package` fails if the manifest ever stops exposing the directory, and
`npm test` fails if a prompt names an agent the package does not ship.

## Panel rules — `/review config`

`/review config` opens the rules in an editor and saves atomically to
`~/.pi/agent/multi-model-review/config.json`. No file means the defaults, which
are upstream/omp exactly:

```json
{
	"families": 1,
	"shardDepth": "auto",
	"crossCheck": false,
	"confirmAboveRuns": 12,
	"exclude": []
}
```

The fields and what each one costs are documented under
[`/review`](#review--upstreams-review-by-default-exactly) above — and the editor
itself explains them, so you do not have to come back here. This section
deliberately does not repeat the list: two copies is how the old one came to
document a field the parser rejects.

A malformed saved config **blocks** the review with an error naming what to fix,
and renamed fields are refused by name rather than being silently ignored. It
never silently launches a different panel, because a saved exclude or threshold
can encode cost or policy intent.

## Dev loop

The checkout is the live install: edit `src/`, restart pi, `/review` picks it
up. No build step — pi loads the TypeScript directly.

```bash
npm run typecheck       # tsc
npm test                # handler harness against real temp git repos
npm run check:upstream  # verbatim upstream files have not drifted
npm run verify:package  # tarball contains every runtime asset
```

Do not hand-edit anything listed as verbatim in `PROVENANCE.md`; put the change
in `src/overrides.ts` or `src/prompts/pi-*.md` instead. `npm run check:upstream`
will catch you.

## Releasing to npm

Repository collaborators with write access can release by pushing a `v<version>`
tag. GitHub Actions tests and packs that commit, then publishes the verified
tarball through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
using a short-lived OIDC identity. No npm login, OTP, or stored npm token is needed
for each release. Stable versions use `latest`; prereleases use `next`.

After the release changes are on `main`:

```bash
npm version patch --no-git-tag-version
VERSION=$(node -p 'require("./package.json").version')
git add package.json package-lock.json
git commit -S -m "Release $VERSION"
git tag -s "v$VERSION" -m "multi-model-review v$VERSION"
git push origin main
git push origin "v$VERSION"
```

The tag must match both version fields in `package-lock.json` and `package.json`.
Check the **Publish npm** Actions run before announcing the release. Existing
tags are not republished when the workflow is added; create a new version rather
than moving a release tag. **Run workflow** validates and packs only—it never
publishes.

One-time owner setup: npm's trusted publisher for `multi-model-review` is
`Scott-Meyer/multi-model-review`, workflow **`publish.yml`**, environment **`npm`**,
with direct publishing allowed. The GitHub environment permits **tags `v*` only**,
with no required reviewer, so collaborators can release without owner approval.
Changing the workflow filename or environment requires updating npm's trust
configuration too.

## License

MIT — see `LICENSE`. Derivative work: portions ported verbatim from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT) and
`@oh-my-pi/pi-utils` (MIT); see `PROVENANCE.md`.
