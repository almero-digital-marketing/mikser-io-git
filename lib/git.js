// Thin wrapper over the `git` binary. Every call goes through execFile
// with argv arrays — never a shell string — so a commit message or
// branch name built from entity ids (arbitrary content from documents)
// can never be interpreted as a shell command.
//
// `run` is the one low-level primitive; everything else composes it.
// Kept thin and exported individually so tests can stub `run` and
// exercise the higher-level functions' argv-building and result
// parsing without a real git binary or network.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// Run a git subcommand in `cwd`. Returns trimmed stdout on success;
// throws with `.stderr` and `.code` attached on failure (execFile's
// own shape) so callers can branch on specific failures (e.g. a
// non-fast-forward push) without string-matching stdout.
// Nothing here may run forever.
//
// Every git operation goes through one queue, so a single command that never
// returns — a push waiting on a credential prompt, a fetch against a host that
// black-holes packets — blocks every later sync pass and the inbound poll,
// permanently and without an error. The symptom is one commit at startup and
// then silence, which reads as "the scheduler died" and is nothing of the
// kind.
//
// execFile's own timeout kills the child and rejects, which the callers
// already handle as any other git failure.
export const GIT_TIMEOUT_MS = 120_000

export async function run(cwd, args, opts = {}) {
    try {
        const { stdout } = await execFileAsync('git', args,
            { cwd, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts })
        return stdout.trim()
    } catch (err) {
        // execFile already attaches .code / .stderr / .stdout to the
        // error; re-throw as-is so callers can inspect them.
        throw err
    }
}

export async function isInsideWorkTree(folder) {
    try {
        const out = await run(folder, ['rev-parse', '--is-inside-work-tree'])
        return out === 'true'
    } catch {
        return false
    }
}

export async function currentBranch(folder) {
    return run(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export async function remoteUrl(folder, remote = 'origin') {
    try {
        return await run(folder, ['remote', 'get-url', remote])
    } catch {
        return null
    }
}

// Auth via a short-lived per-command header, never embedded in the remote
// URL or written to .git/config — an embedded `https://token@host/...`
// remote leaks the token into `git remote -v` output and any log or error
// that echoes the URL.
//
// Delivered through the ENVIRONMENT rather than as a `-c` argument.
// Same semantics, same one-command lifetime, same no-persistence — but a
// process's arguments are world-readable and its environment is not:
//
//     -r--r--r--   /proc/<pid>/cmdline
//     -r--------   /proc/<pid>/environ
//
// As a `-c http.extraheader=...` argument the base64 credential is
// readable by any local user for as long as the git subprocess runs
// (base64 is encoding, not encryption), and it can surface in an
// `err.stderr` that a caller then logs. GIT_CONFIG_COUNT / _KEY_n /
// _VALUE_n is git's own supported equivalent (2.31+) and keeps it out of
// both places.
function authEnv(token) {
    if (!token) return undefined
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64')
    return {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64}`,
    }
}

export async function clone(url, folder, { branch, token } = {}) {
    const args = ['clone', ...(branch ? ['--branch', branch] : []), url, folder]
    // clone's cwd doesn't matter (destination is a full path); run from
    // the parent so a not-yet-existing `folder` isn't required as cwd.
    await run('.', args, { env: authEnv(token) })
}

export async function fetch(folder, { remote = 'origin', token } = {}) {
    await run(folder, ['fetch', remote], { env: authEnv(token) })
}

export async function push(folder, refspec, { remote = 'origin', token, force = false } = {}) {
    const args = ['push', ...(force ? ['--force-with-lease'] : []), remote, refspec]
    await run(folder, args, { env: authEnv(token) })
}

// Non-fast-forward pushes throw with stderr containing "non-fast-forward"
// or "fetch first" (exact wording varies by git version/remote); callers
// that need to distinguish "rejected, needs integration" from other
// failures should check this rather than assuming any push() throw
// means the same thing.
export function isNonFastForwardError(err) {
    const msg = `${err?.stderr ?? ''} ${err?.message ?? ''}`
    return /non-fast-forward|fetch first|rejected/i.test(msg)
}

// `paths`, when given, scopes the command to those pathspecs via git's
// `--` separator — e.g. `['documents', 'layouts']`. This is the actual
// enforcement mechanism behind "this plugin only touches the folders
// you configured": mikser.config.js, node_modules/, runtime/, out/,
// .env can all sit in the SAME checkout (the working folder IS the
// checkout — see index.js) without ever being staged, added, or
// committed, because they're simply not in the pathspec. Omit `paths`
// for the rare whole-repo case (nothing in this plugin currently needs
// that, but the functions stay generally usable).
function pathspecArgs(paths) {
    return paths?.length ? ['--', ...paths] : []
}

export async function statusPorcelain(folder, paths) {
    // --untracked-files=all: without it, git collapses an entire new
    // untracked directory into ONE porcelain line ("?? newdir/") rather
    // than one line per file inside it. Harmless for hasChanges() (any
    // non-empty output still means "changed"), but sync.js derives its
    // commit message's file count from this output's line count — with
    // the default, a brand-new author's folder or category directory
    // would silently undercount (confirmed against a real git repo: a
    // 3-file new directory reported as a single line). `git add`
    // itself was never affected by this — it always stages everything
    // in its scope regardless of how status reports it — this only
    // fixes what the commit message claims happened.
    return run(folder, ['status', '--porcelain', '--untracked-files=all', ...pathspecArgs(paths)])
}

export async function hasChanges(folder, paths) {
    return (await statusPorcelain(folder, paths)).length > 0
}

export async function addAll(folder, paths, { exclude = [] } = {}) {
    // `-A` with a pathspec stages new/modified/deleted files WITHIN
    // that pathspec only — it does not fall back to staging the whole
    // repo. Verified directly (see test/git.test.js) before relying on
    // it as the scope boundary.
    //
    // `exclude` holds paths an open change set has claimed but not yet
    // released. Without it the sweep commits that set's work as
    // unattributed, and the set then finds nothing to commit and settles as
    // empty — its changes are in git under a commit that does not name it,
    // so it can never be undone.
    const excludes = exclude.map(p => `:(exclude)${p}`)
    await run(folder, ['add', '-A', ...pathspecArgs(paths), ...excludes])
}

// Stage an explicit list of files — the change-set path. Distinct from
// addAll's folder pathspec on purpose: this stages what a request wrote and
// nothing that merely happened to be dirty beside it.
//
// `--` separates paths from revisions so a file named like a branch cannot be
// reinterpreted, and `-A` keeps deletions staged as deletions.
export async function addPaths(folder, files) {
    if (!files?.length) return
    await run(folder, ['add', '-A', '--', ...files])
}

// The reverse patch for a commit: the diff from it back to its parent.
//
// This is what makes a dry run possible at all. `git revert` has no
// --dry-run, so the choice is to attempt it in the live working folder and
// deal with a conflicted tree — which for a deployed site means the build
// stops — or to compute the patch and ask `git apply --check` whether it
// would land. The second never touches the tree.
export async function reversePatch(folder, sha, files) {
    const args = ['diff', '--binary', sha, `${sha}^`]
    if (files?.length) args.push('--', ...files)
    return await run(folder, args)
}

// Would this patch apply cleanly? Changes nothing either way.
export async function patchApplies(folder, patch) {
    if (!patch?.trim()) return true
    return await withPatchFile(patch, async (file) => {
        try {
            await run(folder, ['apply', '--check', '--binary', file])
            return true
        } catch {
            return false
        }
    })
}

export async function applyPatch(folder, patch) {
    if (!patch?.trim()) return
    await withPatchFile(patch, (file) => run(folder, ['apply', '--binary', file]))
}

// The patch goes to the system temp dir, never inside the repo: a stray file
// in the working folder is one the plugin's own sweep would commit.
async function withPatchFile(patch, fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-git-patch-'))
    const file = path.join(dir, 'undo.patch')
    try {
        await writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8')
        return await fn(file)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

// Commits carrying a change-set trailer, newest first, with unit separators
// that cannot occur in a commit message.
export async function logChangeSets(folder, { branch, limit = 50, id } = {}) {
    const args = [
        'log', branch ?? 'HEAD',
        `--max-count=${Math.max(1, Math.min(limit, 500))}`,
        '--format=%H%x1f%at%x1f%s%x1f%b%x1e',
        '--grep', id ? `^Mikser-Change-Set: ${id}$` : '^Mikser-Change-Set: ',
    ]
    return await run(folder, args)
}

export async function commit(folder, message, { author } = {}) {
    const args = ['commit', '-m', message]
    if (author?.name)  args.push('--author', `${author.name} <${author.email ?? ''}>`)
    await run(folder, args)
}

// True when there's nothing staged to commit — the caller's signal to
// skip commit() entirely rather than treat "nothing to commit" as an
// error. Cheaper than parsing commit()'s own failure for this one case.
export async function hasStagedChanges(folder, paths) {
    try {
        // --quiet + --exit-code: exits 1 if there ARE differences
        // (i.e. something staged), 0 if the index matches HEAD.
        await run(folder, ['diff', '--cached', '--quiet', ...pathspecArgs(paths)])
        return false
    } catch {
        return true
    }
}

export async function checkoutBranch(folder, branch, { create = false, startPoint } = {}) {
    const args = ['checkout', ...(create ? ['-b'] : []), branch, ...(startPoint ? [startPoint] : [])]
    await run(folder, args)
}

export async function branchExistsLocal(folder, branch) {
    try {
        await run(folder, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
        return true
    } catch {
        return false
    }
}

export async function branchExistsRemote(folder, branch, { remote = 'origin', token } = {}) {
    // ls-remote hits the network but needs no local ref state — safe
    // to call before any fetch has happened.
    const out = await run(folder, ['ls-remote', '--heads', remote, branch], { env: authEnv(token) })
    return out.length > 0
}

// Reset the current branch (HARD — working tree included) to match
// `ref` exactly. Used only to converge the local `mikser` branch onto
// origin/<target> after a successful PR merge, or to recover from a
// rejected push by re-basing onto the fetched remote. Never used to
// discard a user's uncommitted work — every call site commits first.
export async function resetHard(folder, ref) {
    await run(folder, ['reset', '--hard', ref])
}

export async function mergeBranch(folder, ref, { message } = {}) {
    const args = ['merge', '--no-edit', ...(message ? ['-m', message] : []), ref]
    await run(folder, args)
}

export async function abortMerge(folder) {
    try { await run(folder, ['merge', '--abort']) } catch { /* nothing to abort */ }
}

export async function revParse(folder, ref) {
    return run(folder, ['rev-parse', ref])
}
