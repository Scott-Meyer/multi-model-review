# multi-model-review

A `/review` command for [pi](https://github.com/earendil-works/pi) that fans
your diff out to a **diverse multi-model reviewer panel** — one model family
per seat, picked fresh from whatever your session can reach, each running as
its own reviewer subagent — then cross-checks them against each other and
synthesizes one verdict.

> Not affiliated with, endorsed by, or supported by oh-my-pi / Stencil Labs,
> Inc., or by the pi project / Earendil Works. This is a port of oh-my-pi's
> bundled `/review` command (same interactive menu, same diff-stat computation,
> same noise-file exclusion list) with the fan-out reimplemented on pi's own
> subagent machinery. See `PROVENANCE.md` for the file-level breakdown.

## What it does

Run `/review` in any git repo and pick a mode:

1. **Review against a base branch** (PR style) — everything since your branch
   forked, committed *and* uncommitted. The fork point is pinned as a concrete
   merge-base sha up front, so a fast-moving trunk can't shift the reviewed
   range underneath you.
2. **Review uncommitted changes** — staged + unstaged + untracked.
3. **Review a specific commit** — picked from your last 20.
4. **Custom review instructions.**

Lock files, minified/generated code, build output, vendor dirs, images,
fonts, and binaries are stripped from the diff before reviewers see it.

Then the actual review runs in **two passes**, driven by the
[`pi-subagents`](https://www.npmjs.com/package/pi-subagents) `subagent` tool:

- **Pass 1 (independent).** Each seat of the panel looks at the diff
  independently, with fresh context, on its own model. For big diffs each
  reviewer pulls the diff itself rather than having it pasted in.
- **Pass 2 (cross-check).** Each core reviewer's own pass-1 run is resumed and
  handed *all* pass-1 write-ups, unlabeled and anonymized — including its own —
  and explicitly told to distrust all of them and re-verify against the real
  code before agreeing.
- **Synthesis.** The session synthesizes one report from the pass-2 outputs,
  sorted by severity then confidence, flagging anything walked back between
  passes or still in disagreement. One overall verdict.

The extension itself never runs a review — it computes the diff, filters the
noise, and injects a prompt into the current session. The panel runs through
your normal `subagent` tool as a background workflow; you get a report when
pass 2 finishes.

## The panel: personas, and models picked fresh every time

Nothing in this package names a model. At review time the command reads the
models this session can actually reach (session-scoped list if you set one,
otherwise the whole authed registry) and the prompt picks **one model family
per seat** — Claude vs GPT vs Gemini vs GLM vs Qwen, the totally different
lineages — with two routes to the same underlying model (e.g. the same family
at two context sizes) counting as one family. Breadth beats "best": an
older model from a family nobody else on the panel is using is worth more
than a second pick from the same family. If fewer distinct families exist
than seats, the panel shrinks — several seats on one family is a single-model
review with extra steps.

The seats are personas, not models: three identically-instructed
`reviewer-primary` seats (pure model diversity), a blunt Linus-style seat, a
measured Dan-Luu-style seat, and a deliberately pass-1-only antagonist.
Personas ship unpinned — each seat takes its model from the panel pick at
launch.

## Install

**Running from an editable checkout** (recommended if you intend to modify it —
the checkout *is* the install, so edits are live and updates are `git pull`):

```bash
curl -fsSL https://raw.githubusercontent.com/Scott-Meyer/multi-model-review/main/scripts/bootstrap-machine.sh | bash
```

That clones to `$HOME/git/multi-model-review` and registers it as a local-path
package in `~/.pi/agent/settings.json`. Because pi resolves that path relative
to `~/.pi/agent`, the same settings entry works on every machine.

**Or install it as a managed pi package:**

```bash
pi install npm:multi-model-review
pi install git:github.com/Scott-Meyer/multi-model-review@v0.1.0
```

Note: with a managed install, edits must go through a publish round-trip —
use the checkout if you want to hack on it.

**Or add it to `packages` in `~/.pi/agent/settings.json`** (paths are resolved
relative to the agent dir):

```json
{ "packages": ["../../git/multi-model-review"] }
```

Requires the [`pi-subagents`](https://www.npmjs.com/package/pi-subagents)
package (the panel runs through its `subagent` tool) and Node **22.19+**,
matching pi itself.

## Required reviewer agents

The command fans out to pi agents named `reviewer-primary`, `reviewer-linus`,
`reviewer-danluu`, and `reviewer-antagonist` (pass 1 only). These are example
definitions, shipped in the package's `agents/` directory — install them by
copying them into `~/.pi/agent/agents/`:

```bash
# from a checkout of this repo:
cp agents/*.md ~/.pi/agent/agents/

# or from a managed install (pi caches npm and git packages separately):
cp ~/.pi/agent/npm/node_modules/multi-model-review/agents/*.md ~/.pi/agent/agents/
# — or, for a `pi install git:` —
cp ~/.pi/agent/git/github.com/Scott-Meyer/multi-model-review/agents/*.md ~/.pi/agent/agents/
```

`/review` does not work without these agents — the panel fans out to them by
name. (A `pi install` cannot ship them into your agents dir itself; the copy
is the opt-in, so an installed update never clobbers your customized
reviewers.)

The personas have **no model pins** — seats take their model from the panel
pick at launch. The prompt bodies (a blunt Linus-style reviewer, a
measured Dan-Luu-style reviewer, a free-form antagonist) are just starting
points — edit them freely; your customized copies are never clobbered by an
update (the copy is the opt-in).

## Panel rules — `/review config`

The panel is rules, seeded with a smart default. Run `/review config` to
open the effective config in an editor — it saves atomically to
`~/.pi/agent/multi-model-review/config.json`. No file means the smart
default (six seats, no excludes). A saved file IS the rules:

```json
{
	"seats": [
		{ "key": "primary-a", "agent": "reviewer-primary" },
		{ "key": "primary-b", "agent": "reviewer-primary" },
		{ "key": "primary-c", "agent": "reviewer-primary" },
		{ "key": "linus", "agent": "reviewer-linus" },
		{ "key": "danluu", "agent": "reviewer-danluu" },
		{ "key": "antagonist", "agent": "reviewer-antagonist", "pass1Only": true }
	],
	"exclude": []
}
```

- **seats** — the panel: one line per seat (`agent` = a pi agent name, optional
  `model` pin in full `provider/id` form, optional `pass1Only`). Add a seat,
  delete a seat, pin a seat, swap personas — it's your roster. Pinned seats
  skip discovery and keep their pin (an unreachable pin blocks the review
  with an actionable error rather than silently substituting).
- **exclude** — glob strings matched against `provider/model-id` (and the bare
  provider name): shrink the discovery pool, e.g. `"ai-gw-baseten/*"` or
  `"openai"`. Denylist by design: the default stays "whatever it finds", and
  an allowlist would go stale.

A malformed saved config **blocks** the review with an error telling you what
and where to fix — it never silently launches a different panel, because a
saved pin or exclude can encode cost or policy intent.

## Dev loop

The checkout is the live install: edit `src/index.ts`, restart pi (new sessions
load the current code), and `/review` picks up the changes. No build step — pi
loads the TypeScript directly. `npm run typecheck` to keep the compiler happy,
`npm run verify:package` before publishing.

## License

MIT — see `LICENSE`. Derivative work: portions ported from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT); see `PROVENANCE.md`.
