# Provenance

`multi-model-review` is a port, onto pi's own
`@earendil-works/pi-coding-agent` extension API, of the bundled `/review`
command in [oh-my-pi](https://github.com/can1357/oh-my-pi)
(npm `@oh-my-pi/pi-coding-agent`). License: MIT, Copyright (c) 2025 Mario
Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc. — see `LICENSE`.

## Ported from upstream

`src/index.ts` ports oh-my-pi's review command. Same things are preserved
from upstream:

- the interactive review-mode menu (base branch / uncommitted / commit /
  custom),
- the diff-stat computation per file,
- the noise-file exclusion list (lock files, minified/generated code, build
  output, vendor dirs, images, fonts, binaries, snapshots, source maps),
- the overall shape of the prompt handed to the reviewing agent.

## Deliberate deviations from upstream

The port's reason to exist is the fan-out. Instead of handing the diff to N
reviewer copies of one model, the generated prompt instructs the current pi
session to fan the same diff out to a panel of reviewer subagents pinned to
different models, via the `subagent` tool from the
[`pi-subagents`](https://www.npmjs.com/package/pi-subagents) package:

- **Pass 1 (independent):** every reviewer gets the diff (or pulls it itself
  for large diffs) with identical, fresh context.
- **Pass 2 (cross-check):** each core reviewer's own pass-1 run is resumed
  with all pass-1 write-ups pasted in unlabeled and anonymized — including its
  own — and told to re-verify everything against the real code before
  agreeing.
- **Synthesis:** the parent session builds one report from the pass-2
  outputs, flagging walk-backs and unresolved disagreements.

Other deviations from upstream, all documented in code comments:

- file-path extraction from `diff --git` chunks prefers `+++`/`---` marker
  lines over the ambiguous header line, and unwraps git's C-style path
  quoting;
- base-branch reviews pin the fork point as a concrete merge-base sha once,
  up front, instead of relying on `git diff base...current` triple-dot
  re-resolution;
- the diff handed to reviewers covers committed *and* uncommitted changes on
  a branch;
- no base-branch auto-detection: a plain, unranked list of local branches.

## Original to this project

- the two-pass fan-out recipe, the generated `workflowScript` skeleton, and
  the synthesis instructions,
- the reviewer agent definitions in `agents/` (personas and review
  criteria),
- all packaging (`package.json`, scripts, docs).

The reviewer personas are original prompt engineering for this project. They
reference pi agent *names* (`reviewer-claude`, `reviewer-gpt`,
`reviewer-gemini`, `reviewer-glm`, `reviewer-qwen`,
`reviewer-gemini-antagonist`); the `model:` lines in `agents/*.md` are examples
— adjust them to your own provider/model registry.
