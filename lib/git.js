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

const execFileAsync = promisify(execFile)

// Run a git subcommand in `cwd`. Returns trimmed stdout on success;
// throws with `.stderr` and `.code` attached on failure (execFile's
// own shape) so callers can branch on specific failures (e.g. a
// non-fast-forward push) without string-matching stdout.
export async function run(cwd, args, opts = {}) {
    try {
        const { stdout } = await execFileAsync('git', args, { cwd, ...opts })
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

// Auth via a short-lived per-request header, never embedded in the
// remote URL or written to .git/config — an embedded
// `https://token@host/...` remote leaks the token into `git remote -v`
// output and any log/error that echoes the URL. `http.extraheader` is
// passed as a one-off `-c` flag on the specific command that needs it
// (fetch/pull/push/clone), so it never persists to disk.
function authArgs(token) {
    if (!token) return []
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64')
    return ['-c', `http.extraheader=AUTHORIZATION: basic ${b64}`]
}

export async function clone(url, folder, { branch, token } = {}) {
    const args = [...authArgs(token), 'clone', ...(branch ? ['--branch', branch] : []), url, folder]
    // clone's cwd doesn't matter (destination is a full path); run from
    // the parent so a not-yet-existing `folder` isn't required as cwd.
    await run('.', args)
}

export async function fetch(folder, { remote = 'origin', token } = {}) {
    await run(folder, [...authArgs(token), 'fetch', remote])
}

export async function push(folder, refspec, { remote = 'origin', token, force = false } = {}) {
    const args = [...authArgs(token), 'push', ...(force ? ['--force-with-lease'] : []), remote, refspec]
    await run(folder, args)
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

export async function statusPorcelain(folder) {
    return run(folder, ['status', '--porcelain'])
}

export async function hasChanges(folder) {
    return (await statusPorcelain(folder)).length > 0
}

export async function addAll(folder) {
    await run(folder, ['add', '-A'])
}

export async function commit(folder, message, { author } = {}) {
    const args = ['commit', '-m', message]
    if (author?.name)  args.push('--author', `${author.name} <${author.email ?? ''}>`)
    await run(folder, args)
}

// True when there's nothing staged to commit — the caller's signal to
// skip commit() entirely rather than treat "nothing to commit" as an
// error. Cheaper than parsing commit()'s own failure for this one case.
export async function hasStagedChanges(folder) {
    try {
        // --quiet + --exit-code: exits 1 if there ARE differences
        // (i.e. something staged), 0 if the index matches HEAD.
        await run(folder, ['diff', '--cached', '--quiet'])
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
    const out = await run(folder, [...authArgs(token), 'ls-remote', '--heads', remote, branch])
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
