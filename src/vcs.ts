/**
 * VCS layer — the one part of this port that can never be upstream's.
 *
 * omp's `/review` used to call `utils/git` + `utils/jj` helpers; as of
 * 18.1.0 it calls `@oh-my-pi/pi-natives/vcs`, a NATIVE module. Native code
 * cannot be vendored into a pi extension, so this file reimplements exactly
 * the surface the review command uses, over `git`/`jj`/`gh` subprocesses.
 *
 * The contract is behavioural, not structural: each function mirrors what the
 * corresponding upstream call returns for the review command's purposes,
 * including upstream's error posture (swallow-to-empty where upstream
 * swallows, throw where upstream throws). Where this file deliberately does
 * something upstream does not, the comment says DEVIATION and why.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class VcsError extends Error {}

interface ExecFileError {
	status?: number | null;
	code?: string;
	stdout?: string;
	stderr?: string;
	message?: string;
}

export interface DiffSize {
	files: number;
	insertions: number;
	deletions: number;
}

/**
 * Size a diff without buffering it, via `--shortstat` (one short line of
 * output regardless of how big the change is).
 *
 * This exists because the honest answer to "your diff is 900k lines" is a
 * clear message, not a crash. Probing first also means the user learns they
 * picked the wrong base immediately, instead of after a long stall.
 */
export function shortstat(cwd: string, diffArgs: string[]): DiffSize {
	return parseShortstat(run("git", cwd, [...diffArgs, "--shortstat", ...DIFF_SCOPE_FLAGS]));
}

/**
 * Read `--shortstat` output. Safe against a localized git only because every
 * caller runs it through childEnv() (LC_ALL=C) — see that function.
 */
function parseShortstat(out: string): DiffSize {
	const files = /(\d+) files? changed/.exec(out);
	const insertions = /(\d+) insertions?\(\+\)/.exec(out);
	const deletions = /(\d+) deletions?\(-\)/.exec(out);
	return {
		files: files ? Number(files[1]) : 0,
		insertions: insertions ? Number(insertions[1]) : 0,
		deletions: deletions ? Number(deletions[1]) : 0,
	};
}

/**
 * Ceilings for what this command will attempt to buffer and parse. Chosen so a
 * legitimately big feature branch still goes through, while "you diffed against
 * a 2019 release branch" stops with an explanation.
 */
export interface DiffLimits {
	files: number;
	lines: number;
}

export const DIFF_LIMITS: DiffLimits = { files: 2_000, lines: 400_000 };

/**
 * Pure size check, kept separate from the git call so it is directly testable.
 * Returns an actionable message, or undefined when the diff is reviewable.
 */
export function diffTooLargeMessage(size: DiffSize, what: string, limits: DiffLimits = DIFF_LIMITS): string | undefined {
	const lines = size.insertions + size.deletions;
	const overFiles = size.files > limits.files;
	const overLines = lines > limits.lines;
	if (!overFiles && !overLines) return undefined;
	const measured = `${size.files.toLocaleString()} files and ${lines.toLocaleString()} changed lines`;
	const limit = overFiles ? `${limits.files.toLocaleString()} files` : `${limits.lines.toLocaleString()} lines`;
	return (
		`${what} covers ${measured}, past this command's ${limit} ceiling. ` +
		`A panel review of something that size would be neither reliable nor cheap. ` +
		`Most often the base isn't the branch you actually forked from — or review a single commit, or narrow the change first.`
	);
}

/**
 * 256 MiB. Large diffs are the normal failure mode here, not an exotic one: a
 * monorepo plus a base branch that forked long ago produces hundreds of MB of
 * `git diff` output, and spawnSync fails the whole call with a bare ENOBUFS
 * once it exceeds this. Callers should size a diff with shortstat() BEFORE
 * fetching it; this is the backstop, not the strategy.
 */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Child environment for every VCS subprocess.
 *
 * `LC_ALL=C` is load-bearing, not tidiness. git's diffstat summary is a
 * translated string, and `shortstat()` plus `netWorktreeDiff()` size a diff by
 * regexing the English `N files changed` / `insertions(+)` / `deletions(-)`. On
 * a git built with message catalogs and a non-English LANG, all three regexes
 * miss, the size reads as zero, and the DIFF_LIMITS ceiling silently stops
 * applying — so instead of "this diff is too large, here are the numbers" the
 * user gets a long stall ending at the 256 MB ENOBUFS backstop. Pinning the
 * locale for the child costs nothing and removes the dependency entirely.
 *
 * Computed per call, NOT snapshotted at module load. A frozen copy silently
 * ignores every later change to `process.env` — including the PATH a caller or
 * test sets to control which `git`/`gh` binary is found, which is exactly the
 * kind of override that must keep working after this module is imported.
 */
function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...process.env, LC_ALL: "C", ...extra };
}

/**
 * Flags that fix WHICH paths a diff covers, as opposed to how it is formatted.
 *
 * `diff.relative=true` restricts every diff to the current directory. Run from a
 * subdirectory that silently shrinks the review, and it must be neutralised on
 * the size probe and the `--name-only -z` path list as well as on the payload,
 * not just one of them: `coverageGaps` reconciles the paths the parser surfaced
 * against git's own path list, so a narrowed list beside a full payload reports
 * paths as unreviewed that were in fact reviewed, and a narrowed payload beside
 * a full list hides real omissions. Both halves must agree, which means both
 * halves need the flag.
 */
const DIFF_SCOPE_FLAGS = ["--no-relative"];

/**
 * Flags that force git to emit the diff format `parseDiff` actually accepts.
 *
 * `parseDiff` matches `diff --git a/<path> b/<path>` exactly (it is verbatim
 * upstream and not ours to loosen), but that header shape is user-configurable:
 * `diff.noprefix=true` yields `diff --git f.txt f.txt`, `diff.mnemonicPrefix`
 * yields `c/f.txt w/f.txt`, `color.ui=always` prefixes every line with ANSI
 * escapes even into a pipe, and `diff.external` replaces the diff wholesale.
 * With any of those set in the user's ~/.gitconfig, every header fails to
 * match, `stats.files.length` is 0, and the review aborts with "No reviewable
 * files (all changes filtered out)" — a total failure whose cause is invisible
 * from the message. Explicit flags beat inherited configuration here.
 *
 * `--submodule=short` is here for a related reason: `diff.submodule=log`
 * replaces a submodule pointer change with a `Submodule a..b (rewind):` summary
 * and emits no `diff --git` header at all, where the short form is a reviewable
 * `-Subproject commit` / `+Subproject commit` hunk.
 *
 * All of these are no-ops under default configuration.
 */
const DIFF_FORMAT_FLAGS = [...DIFF_SCOPE_FLAGS, "--no-ext-diff", "--no-color", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/"];

/** ENOBUFS is what spawnSync reports when output exceeds maxBuffer. */
function isOutputTooLarge(e: ExecFileError): boolean {
	return e.code === "ENOBUFS" || /ENOBUFS|maxBuffer/i.test(e.message ?? "");
}

function run(cmd: string, cwd: string, args: string[]): string {
	try {
		return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env: childEnv() });
	} catch (err) {
		const e = err as ExecFileError;
		// Always name the command. A bare "spawnSync git ENOBUFS" tells the user
		// nothing about which operation died or what to do about it.
		const invocation = `${cmd} ${args.join(" ")}`;
		if (isOutputTooLarge(e)) {
			throw new VcsError(
				`\`${invocation}\` produced more than ${Math.round(MAX_BUFFER / (1024 * 1024))} MB of output, which is too much to review in one pass. ` +
					`This usually means the two ends are much further apart than intended — check the base is the branch you actually forked from, ` +
					`or review a single commit instead.`,
			);
		}
		throw new VcsError(e.stderr?.trim() || `${e.message || "failed"} (running \`${invocation}\`)`);
	}
}

export function git(cwd: string, args: string[]): string {
	return run("git", cwd, args);
}


export function isGitRepo(cwd: string): boolean {
	try {
		git(cwd, ["rev-parse", "--is-inside-work-tree"]);
		return true;
	} catch {
		return false;
	}
}

/** True when cwd is a jj repo. Mirrors upstream's `repository.kind() === "jj"`. */
export function isJjRepo(cwd: string): boolean {
	try {
		run("jj", cwd, ["--ignore-working-copy", "root"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Local branches, most recently committed first, capped.
 *
 * DEVIATION (UI only, does not change what gets reviewed): upstream calls
 * `listBranches(true)` — every local AND remote-tracking ref — and hands the
 * whole thing to a picker. pi's `ctx.ui.select` is a plain arrow-key list with
 * no filtering, search or paging, so in a monorepo with thousands of branches
 * that picker is unusable: you scroll for a very long time. Recency is also the
 * useful order here and alphabetical is not — nobody forks from the
 * alphabetically-first branch.
 *
 * The base branch can still be anything: the caller asks for a name first and
 * only falls back to this list, so remote refs like `origin/main` and branches
 * past the cap remain reachable by typing them.
 *
 * Swallows errors to [] exactly as upstream's `getGitBranches` does.
 */
export function recentLocalBranches(cwd: string, limit: number): string[] {
	try {
		const out = git(cwd, [
			"for-each-ref",
			"--sort=-committerdate",
			`--count=${limit}`,
			"--format=%(refname:short)",
			"refs/heads",
		]);
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Every branch, local and remote, most-recently-committed first.
 *
 * This is the pool the type-to-filter picker searches, so `origin/main` and
 * long-lived remote branches stay reachable. Fetching all of them is one cheap
 * process even in a monorepo (a few tens of KB of ref names); what was never
 * affordable was *rendering* them all, which is why the caller filters before
 * ever handing anything to a picker.
 */
export function allBranchesByRecency(cwd: string): string[] {
	return allBranchesWithAge(cwd).map((b) => b.name);
}

export interface BranchInfo {
	name: string;
	/** Relative commit date, e.g. "2 hours ago". */
	age: string;
	remote: boolean;
}

/**
 * Every branch with its relative commit date, most recent first.
 *
 * The age is what makes a bounded list usable: with thousands of branches the
 * question is never "which is alphabetically first" but "which did I touch
 * recently", and `preprod (3 minutes ago)` vs `preprod (8 months ago)` settles
 * it at a glance.
 */
export function allBranchesWithAge(cwd: string): BranchInfo[] {
	try {
		const out = git(cwd, [
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(refname:short)%09%(committerdate:relative)%09%(refname)",
			"refs/heads",
			"refs/remotes",
		]);
		const branches: BranchInfo[] = [];
		for (const line of out.split("\n")) {
			if (!line.trim()) continue;
			const [name, age = "", fullRef = ""] = line.split("\t");
			if (!name || name.endsWith("/HEAD")) continue;
			branches.push({ name, age, remote: fullRef.startsWith("refs/remotes/") });
		}
		return branches;
	} catch {
		return [];
	}
}

/** Total local branch count, for telling the user the list is truncated. */
export function localBranchCount(cwd: string): number {
	try {
		return git(cwd, ["for-each-ref", "--format=.", "refs/heads"]).split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

/** True when `ref` resolves to a commit — so a typo is caught before diffing. */
export function refExists(cwd: string, ref: string): boolean {
	try {
		git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/** Upstream: `currentBranch() ?? "HEAD"`, errors swallowed to "HEAD". */
export function currentBranch(cwd: string): string {
	try {
		return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "HEAD";
	} catch {
		return "HEAD";
	}
}

/**
 * Fork point, or undefined when the two refs share no history.
 *
 * Upstream 18.1.0 does exactly this — `mergeBase(base, head)` and then a
 * two-dot diff from it — and notifies "No common history" on a null result,
 * rather than letting `git diff base...head` compare unrelated trees.
 */
export function mergeBase(cwd: string, base: string, head: string): string | undefined {
	try {
		return git(cwd, ["merge-base", base, head]).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * A command a reviewer can run to reproduce the reviewed snapshot for its paths.
 *
 * Needed because the payload is built through a throwaway index that is deleted
 * immediately (see netWorktreeDiff). When the diff is too large to inline, seats
 * fetch their own hunks — and plain `git diff <base> -- <path>` is index-aware,
 * so it reports a `git rm --cached`ed file as deleted (losing edits) and omits
 * new files entirely. A reviewer following that would review a deletion that
 * never happened while the file table beside it said "modified".
 *
 * Three details are load-bearing:
 *
 *   - the whole worktree is staged (`git add -A`), not just the requested paths.
 *     Staging one path leaves the rest of the temp index at `base`, which turns
 *     a rename into a bare addition and loses the rename metadata entirely.
 *   - the temp index is created with `mktemp -d`, not `mktemp -u`. The latter
 *     only invents a name, which is a race.
 *   - every assigned path goes in ONE invocation. That amortises the tree walk,
 *     and rename detection is a property of the whole diff: filtering to one
 *     half of a rename pair reports it as an add or a delete even when the index
 *     is staged correctly.
 *
 * Read-only with respect to the repository: `GIT_INDEX_FILE` points into a temp
 * directory, so `git add` writes only there, never the real index or worktree.
 *
 * `base` is null for an unborn HEAD, which emits the same `--empty` /
 * base-less form netWorktreeDiff uses, so the reviewer reproduces exactly the
 * payload it was sent.
 */
export function reproduceSnapshotCommand(base: DiffBase): string {
	const readTree = base === null ? "read-tree --empty" : `read-tree ${base}`;
	const diffBase = base === null ? "" : `${base} `;
	// Two details beyond the temp index:
	//
	// DIFF_FORMAT_FLAGS, for the same reason the payload carries them: seats run
	// this in the user's own repo under the user's own config, so without them a
	// `diff.external` or `diff.relative` user's reviewers get something other than
	// — or less than — the diff they were told they were reproducing.
	//
	// `git -C <toplevel>`, because the paths we hand out are repo-root-relative
	// (that is what `--name-only` reports, and what --no-relative pins it to) while
	// git resolves PATHSPECS against the current directory. Launched from a
	// subdirectory, a seat given `sub/x.ts` would look for `sub/sub/x.ts` and fetch
	// nothing at all — an empty review that looks like a clean one. Running git at
	// the top level makes both halves repo-relative.
	const git = 'git -C "$R"';
	return (
		`D=$(mktemp -d) && R=$(git rev-parse --show-toplevel) && ` +
		`GIT_INDEX_FILE=$D/index ${git} ${readTree} && ` +
		`GIT_INDEX_FILE=$D/index ${git} add -A && ` +
		`GIT_INDEX_FILE=$D/index ${git} diff --cached ${DIFF_FORMAT_FLAGS.join(" ")} ${diffBase}-- ` +
		`<all your assigned paths>; rm -rf "$D"`
	);
}

/**
 * What a worktree snapshot is compared against: a revision, or null when HEAD is
 * unborn.
 *
 * Null rather than a hardcoded empty-tree SHA. The well-known
 * `4b825dc642cb6eb9a060e54bf8d69288fbee4904` is the *sha1* empty tree, and a
 * repository created with `--object-format=sha256` rejects it outright (`fatal:
 * Not a valid object name`), so that constant would have traded a crash in every
 * new repo for a crash in every sha256 repo. `read-tree --empty` plus a
 * base-less `diff --cached` needs no hash at all and behaves identically under
 * both object formats.
 */
export type DiffBase = string | null;

/**
 * Snapshot command for the HEADLESS path.
 *
 * Headless builds its prompt before any review mode is chosen, and — unlike the
 * interactive paths — returns before the `isGitRepo || isJjRepo` guard, so it
 * never learns which VCS it is in. This function does that detection itself
 * rather than emitting a git command and hoping.
 *
 * Hoping was the previous behaviour and it failed silently, which is the worst
 * available outcome: in a non-colocated jj workspace there is no `.git`, so
 * `R=$(git rev-parse --show-toplevel)` fails, the `&&` chain short-circuits, and
 * the trailing `rm -rf` makes the whole thing exit 0 with EMPTY stdout. A seat
 * running it got no diff and no error — an empty review indistinguishable from a
 * clean one, in a repo shape the README explicitly advertises.
 *
 * The git form is deliberately NOT `git diff HEAD`: that omits files never
 * `git add`ed, which reviewing is this port's whole reason for staging a
 * worktree, and it fails before the first commit.
 *
 * Returns undefined when the directory is neither, because headless `/review` is
 * repo-agnostic by design (upstream's headless template makes no repo
 * assumption, and this command is reachable outside a checkout). Emitting a git
 * command there would reintroduce the same silent-empty failure it exists to
 * remove; the prompt asks for scope in prose instead.
 */
export function snapshotCommandFor(cwd: string): string | undefined {
	// jj first: a colocated workspace has BOTH .jj and .git, and there the jj
	// working copy is the authoritative view of the change.
	if (isJjRepo(cwd)) return "jj --ignore-working-copy --color=never diff --git";
	if (!isGitRepo(cwd)) return undefined;
	const git = 'git -C "$R"';
	return (
		`D=$(mktemp -d) && R=$(git rev-parse --show-toplevel) && ` +
		`{ GIT_INDEX_FILE=$D/index ${git} read-tree HEAD 2>/dev/null || ` +
		`GIT_INDEX_FILE=$D/index ${git} read-tree --empty; } && ` +
		`GIT_INDEX_FILE=$D/index ${git} add -A && ` +
		`GIT_INDEX_FILE=$D/index ${git} diff --cached ${DIFF_FORMAT_FLAGS.join(" ")}; rm -rf "$D"`
	);
}

export interface NetDiff {
	size: DiffSize;
	/** Undefined when the change is past the reviewable ceiling. */
	diff?: string;
	/**
	 * Every path git reports as changed, raw and NUL-separated.
	 *
	 * This is the authoritative list, used to catch paths the diff parser cannot
	 * surface. Git quotes hostile names in diff headers
	 * (`diff --git "a/we\`ird\\nname.bin" ...`), which upstream's header regex does
	 * not match — so such a file would otherwise vanish from the review and from
	 * every warning about it. Reconciling against this list turns a silent drop
	 * into a declared coverage gap without touching the verbatim parser.
	 */
	changedPaths: string[];
}

/**
 * The net diff from `base` to what is actually ON DISK, as one snapshot.
 *
 * Built through a throwaway index rather than `git diff <base>`, because
 * `git diff` is index-aware in ways that misreport the working tree:
 *
 *   - `git rm --cached f` leaves `f` on disk, but `git diff <base>` calls it
 *     deleted and loses any edits made to it;
 *   - untracked files are absent entirely, so new work is invisible.
 *
 * Patching around that by appending synthetic diffs cannot fix the first case:
 * suppressing the duplicate leaves the false deletion, and keeping both puts one
 * path in the payload twice. Reading `base` into a temporary index, staging every
 * non-ignored worktree path into it, and diffing that gives base -> disk in one
 * correct patch: commits, staged, unstaged and brand-new files together, no
 * concatenation and nothing to de-duplicate.
 *
 * The real index is never touched — `GIT_INDEX_FILE` points elsewhere for the
 * duration, and `git add` only writes to that index, never to the worktree.
 * Sizing happens against the same temporary index so the probe and the payload
 * cannot disagree.
 */
export function netWorktreeDiff(cwd: string, base: DiffBase, limits: DiffLimits = DIFF_LIMITS): NetDiff {
	const indexFile = join(tmpdir(), `mmr-index-${process.pid}-${Date.now()}`);
	const env = childEnv({ GIT_INDEX_FILE: indexFile });
	const run = (args: string[]): string => {
		try {
			return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env });
		} catch (err) {
			const e = err as ExecFileError;
			if (isOutputTooLarge(e)) {
				throw new VcsError(
					`\`git ${args.join(" ")}\` produced more than ${Math.round(MAX_BUFFER / (1024 * 1024))} MB of output, ` +
						`which is too much to review in one pass. Check the base is the branch you actually forked from.`,
				);
			}
			throw new VcsError(e.stderr?.trim() || e.message || `git ${args.join(" ")} failed`);
		}
	};

	// Omitting the base entirely is what makes an unborn HEAD work: `diff --cached`
	// with no revision compares the index against HEAD, and git treats an unborn
	// HEAD as the empty tree, so every file reads as an addition.
	const baseArgs = base === null ? [] : [base];
	try {
		run(base === null ? ["read-tree", "--empty"] : ["read-tree", base]);
		// Stages additions, modifications and deletions, honouring .gitignore.
		run(["add", "--all"]);
		const size = parseShortstat(run(["diff", "--cached", ...baseArgs, "--shortstat", ...DIFF_SCOPE_FLAGS]));
		const changedPaths = run(["diff", "--cached", ...baseArgs, "--name-only", "-z", ...DIFF_SCOPE_FLAGS])
			.split("\0")
			.filter(Boolean);
		if (size.files > limits.files || size.insertions + size.deletions > limits.lines) {
			return { size, changedPaths };
		}
		return { size, diff: run(["diff", "--cached", ...baseArgs, ...DIFF_FORMAT_FLAGS]), changedPaths };
	} finally {
		rmSync(indexFile, { force: true });
	}
}

/**
 * Upstream: `showCommit(hash)` / `git.show(cwd, hash, { format: "" })`.
 *
 * Carries DIFF_FORMAT_FLAGS for the same reason netWorktreeDiff does: this
 * output goes straight into `parseDiff`, so a user's `diff.noprefix` or
 * `color.ui=always` would make every header unparseable and the commit read as
 * having no reviewable files.
 */
export function showCommit(cwd: string, hash: string): string {
	return git(cwd, ["show", hash, "--format=", ...DIFF_FORMAT_FLAGS]);
}

/** Upstream: `logOnelines(count)`, errors swallowed to []. */
export function recentCommits(cwd: string, count: number): string[] {
	try {
		return git(cwd, ["log", `-${count}`, "--oneline"]).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** Upstream jj path: `jj --ignore-working-copy diff --git`. */
export function jjWorkingCopyDiff(cwd: string): string {
	// `--color=never` for the same reason git gets `--no-color`: this output goes
	// straight to parseDiff, and jj's `ui.color = "always"` forces escapes into
	// non-tty output, which would make every header unparseable.
	return run("jj", cwd, ["--ignore-working-copy", "--color=never", "diff", "--git"]);
}

function hasAnyChanges(cwd: string): boolean {
	// `-uall` is required, not decorative: without it `status.showUntrackedFiles=no`
	// makes a tree whose ONLY changes are new files report as clean, and this
	// function is the gate in front of the whole uncommitted path. Reviewing files
	// that were never `git add`ed is the deviation this module exists for, so
	// answering "no uncommitted changes" there is the worst available outcome.
	return git(cwd, ["status", "--porcelain", "-z", "-uall"]).length > 0;
}

export interface WorkingTreeStatus {
	staged: number;
	unstaged: number;
	untracked: number;
}

/**
 * Counts of staged / unstaged / untracked paths.
 *
 * Needed because base-branch review compares COMMITTED state: if the working
 * tree is dirty, the reviewed snapshot is not the code the user is looking at.
 * That has to be surfaced, not assumed away — see the base-branch flow in
 * index.ts.
 */
export function workingTreeStatus(cwd: string): WorkingTreeStatus {
	const out = git(cwd, ["status", "--porcelain", "-z", "-uall"]);
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	// Indexed rather than for-of because a rename or copy emits TWO NUL-terminated
	// fields — `R  new.txt\0old.txt\0` — and the second is a bare origin path, not a
	// status entry. Read naively it parses as one: `old.txt`[0] and [1] are `o` and
	// `l`, neither is a space, so a single `git mv` counted as both a staged AND an
	// unstaged change. That miscount is not cosmetic; it reaches the reviewers,
	// because index.ts puts these numbers in the `mode` line sent to every seat,
	// which would have described a rename-only tree as having unstaged edits.
	const entries = out.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 2) continue;
		const index = entry[0];
		const worktree = entry[1];
		if (index === "R" || index === "C" || worktree === "R" || worktree === "C") i++;
		if (index === "?" && worktree === "?") {
			untracked++;
			continue;
		}
		if (index !== " ") staged++;
		if (worktree !== " ") unstaged++;
	}
	return { staged, unstaged, untracked };
}

/**
 * Untracked, non-ignored paths. NUL-separated so path quoting can't confuse us.
 *
 * These are NOT added to the diff — upstream reviews staged + unstaged only,
 * and this port matches that. They are reported so the omission is visible:
 * a brand-new file is usually the most interesting part of a change, and
 * "the reviewers never saw it" should not be silent. The user can `git add`
 * and re-run.
 */
export function untrackedFiles(cwd: string): string[] {
	const out = git(cwd, ["status", "--porcelain", "-z", "-uall"]);
	const paths: string[] = [];
	// Skips rename/copy origin fields for the same reason workingTreeStatus does:
	// `R  new\0old\0` is one status entry followed by a bare path. A renamed file
	// whose ORIGIN path happens to start with `??` would otherwise be read as an
	// untracked entry and mangled by slice(3) into a path that does not exist,
	// which then reaches the prompt as an unreviewed new file.
	const entries = out.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 2) continue;
		if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") i++;
		else if (entry.startsWith("??")) paths.push(entry.slice(3));
	}
	return paths;
}

export interface UncommittedDiff {
	diffText: string;
	mode: string;
	diffInstruction: string;
	emptyMessage: string;
	size: DiffSize;
	/** True when the change is past the reviewable ceiling. */
	tooLarge: boolean;
	/** Authoritative changed-path list; see NetDiff.changedPaths. */
	changedPaths: string[];
}

/** Upstream's GIT_/JJ_ uncommitted diff instructions, verbatim strings. */
const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

/**
 * Uncommitted work: HEAD -> disk, through the same temporary-index primitive.
 *
 * DEVIATION from upstream, deliberate: upstream diffs staged + unstaged only, so
 * a file that has never been `git add`ed is invisible. A brand-new file is
 * usually the most important thing in a change, and requiring `git add` before a
 * review tool will look at your code is a workflow tax with no upside.
 */
export function uncommittedDiff(cwd: string, limits: DiffLimits = DIFF_LIMITS): UncommittedDiff {
	if (isJjRepo(cwd)) {
		return {
			diffText: jjWorkingCopyDiff(cwd),
			diffInstruction: JJ_UNCOMMITTED_DIFF_INSTRUCTION,
			emptyMessage: "No uncommitted changes found",
			mode: "Reviewing JJ working-copy changes",
			size: { files: 0, insertions: 0, deletions: 0 },
			tooLarge: false,
			changedPaths: [],
		};
	}

	const mode = "Reviewing uncommitted changes (staged + unstaged + new files)";
	if (!hasAnyChanges(cwd)) {
		return {
			diffText: "",
			diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
			emptyMessage: "No uncommitted changes found",
			mode,
			size: { files: 0, insertions: 0, deletions: 0 },
			tooLarge: false,
			changedPaths: [],
		};
	}

	// An unborn HEAD is not an edge case to shrug at: it is the state of every
	// repository before its first commit, and this command's whole reason for
	// staging the worktree is to review files that have never been committed.
	// `git read-tree HEAD` exits 128 with `fatal: Not a valid object name HEAD`
	// there, which surfaced as a raw git error on `/review` in a fresh repo.
	const base: DiffBase = refExists(cwd, "HEAD") ? "HEAD" : null;
	const net = netWorktreeDiff(cwd, base, limits);
	return {
		diffText: net.diff ?? "",
		diffInstruction:
			`MUST reproduce the reviewed snapshot for each assigned file with ` +
			`\`${reproduceSnapshotCommand(base)}\` (read-only: it writes a throwaway index, never the real ` +
			`one). Plain \`git diff\`/\`git diff --cached\` will NOT match: they are index-aware, so a ` +
			`\`git rm --cached\`ed file reads as deleted and new files are missing.`,
		emptyMessage: "No diff content found",
		mode,
		size: net.size,
		tooLarge: net.diff === undefined,
		changedPaths: net.changedPaths,
	};
}

/**
 * PR unified diff.
 *
 * ADAPTED: upstream fetches through its own gh cache (`gh.getOrFetchPrDiff`)
 * and then points reviewers at `pr://<repo>/<n>/diff/...`, a resource scheme
 * that only exists inside omp. pi has no resolver for it, so we fetch with the
 * `gh` CLI and the reviewer instructions name `gh pr diff` instead — a copied
 * `pr://` URL would be a dead link in the reviewer's hands.
 */
export function fetchPrDiff(cwd: string, repo: string, number: number): string {
	return run("gh", cwd, ["pr", "diff", String(number), "--repo", repo]);
}
