# multi-model-review

A `/review` command for [pi](https://github.com/earendil-works/pi) that fans
your diff out to a **five-model reviewer panel** — Claude, GPT, Gemini, GLM
and Qwen, each running as its own reviewer subagent — then cross-checks them
against each other and synthesizes one verdict.

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

- **Pass 1 (independent).** Each of the five reviewers (plus one deliberately
  antagonistic extra voice) looks at the diff independently, with fresh
  context. For big diffs each reviewer pulls the diff itself rather than
  having it pasted in.
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

The command fans out to pi agents named `reviewer-claude`, `reviewer-gpt`,
`reviewer-gemini`, `reviewer-glm`, `reviewer-qwen`, and (pass 1 only)
`reviewer-gemini-antagonist`. These are example definitions, shipped in the package's `agents/` directory —
install them by copying them into `~/.pi/agent/agents/`:

```bash
# from a checkout of this repo:
cp agents/*.md ~/.pi/agent/agents/

# or from an npm/git install (pi caches managed packages under ~/.pi/agent):
cp ~/.pi/agent/npm/node_modules/multi-model-review/agents/*.md ~/.pi/agent/agents/
```

`/review` does not work without these agents — the panel fans out to them by
name. (A `pi install` cannot ship them into your agents dir itself; the copy
is the opt-in, so an installed update never clobbers your customized
reviewers.)

The `model:` line in each file is an **example, not a default** — it pins each
reviewer to a model through my personal provider registry. Change it to a
`provider/model` pair that exists in yours (see
[pi docs on models](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/models.md)).
The personas (a blunt Linus-style GLM, a Dan-Luu-style Qwen, and an
unstructured antagonistic Gemini) are just starting points — edit the prompt
bodies freely.

## Changing the panel

Edit the `CORE_REVIEWERS` / `EXTRA_PASS1_REVIEWERS` rosters at the top of
[`src/index.ts`](src/index.ts):

- `CORE_REVIEWERS` run both passes (independent review + cross-check resume).
- `EXTRA_PASS1_REVIEWERS` run pass 1 only — their write-up is still folded into
  what every core reviewer sees in pass 2, unlabeled, but they don't get a
  cross-check round of their own. Good for a cheap, deliberately different
  voice.

Each entry needs a matching agent definition (`agent:` field) in your agents
dir.

## Dev loop

The checkout is the live install: edit `src/index.ts`, restart pi (new sessions
load the current code), and `/review` picks up the changes. No build step — pi
loads the TypeScript directly. `npm run typecheck` to keep the compiler happy,
`npm run verify:package` before publishing.

## License

MIT — see `LICENSE`. Derivative work: portions ported from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT); see `PROVENANCE.md`.
