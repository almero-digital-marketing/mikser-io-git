// Make an inbound merge able to materialise a NEW Git-LFS object.
//
// Checking out an LFS-tracked file runs the smudge filter as its own process,
// and that process resolves its endpoint from the remote it is merging —
// here `origin`. Where origin is HTTPS with no stored credentials, a daemon
// has nothing to answer the prompt with and git-lfs fatals:
//
//     fatal: could not read Username for 'https://...': No such device or address
//     error: external filter 'git-lfs filter-process' failed
//     fatal: media/new.mp4: smudge filter lfs failed
//
// An object that was already in the local cache before this host was set up
// smudges fine with no network at all, which is why only a file NEW to an
// inbound commit hits this.
//
// WHAT THE FAILURE ACTUALLY LEAVES BEHIND, measured rather than assumed:
//
//   - HEAD does NOT advance.
//   - There is NO MERGE_HEAD, so `git merge --abort` cannot help it —
//     it exits "fatal: There is no merge to abort".
//   - The working folder is NOT untouched. The merge had already written the
//     incoming commit's OTHER files before it reached the LFS one, so a
//     sibling edit is applied and the LFS file is absent.
//
// That last part is the damage. The half-applied tree is uncommitted work as
// far as everything downstream can tell: mikser's watcher sees the sibling
// change, the sync pass commits it, and the promote carries a tree built on
// the OLD commit — without the new media — to the target branch. It also
// blocks every later merge ("Please commit your changes or stash them before
// you merge"), which is the 30-second loop: permanent until a human cleans up.
//
// So the objects are checked BEFORE the merge starts, and a merge that cannot
// be completed is never begun. Prevention, not recovery — recovery would mean
// discarding working-folder changes, and this folder holds live uncommitted
// edits made through MCP.
//
// Rejected alternatives, both of which were on the table:
//
//   Disabling the smudge for the merge (`-c filter.lfs.process=`) and running
//   `git lfs pull` after. The merge then writes POINTER text where the media
//   should be, and this working folder is what the site serves — so there is
//   a window in which every video is a 130-byte text file. A window is worse
//   than a deferred merge.
//
//   Pointing `lfs.url` at the SSH remote. That is a persistent repo-config
//   change made behind the operator's back, and it redirects every other tool
//   in the checkout too.
//
//   Giving the MERGE the auth header the rest of the plugin uses. Even where
//   git-lfs honours it, it puts a network round-trip inside the merge — which
//   is the thing that fatals. Resolving from a warm cache is the goal, not
//   authenticating later.

import path from 'node:path'
import { existsSync } from 'node:fs'

import * as git from './git.js'

// An SSH remote authenticates with a key, which a daemon HAS. An HTTPS one
// wants a username, which is exactly what it cannot supply — so SSH is tried
// first when nothing is configured.
//
// Both spellings: explicit `ssh://`, and the scp-like `git@host:owner/repo`.
// The scheme test comes first so `https://` is never mistaken for scp-like on
// account of the colon.
export function isSshUrl(url) {
    if (!url) return false
    if (/^ssh:\/\//i.test(url)) return true
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false
    return /^[^/\s]+@[^/\s]+:/.test(url)
}

// Which LFS objects this ref needs that are NOT in the local cache.
//
// `git lfs ls-files --long <ref>` prints `<oid> <marker> <path>`. The marker
// is NOT the answer: it describes the WORKING TREE — `*` when that file is
// checked out as a full object, `-` when it is a pointer or absent. For a ref
// that is not checked out, which is every inbound ref, everything reads `-`
// whatever the cache holds. Measured: an object sitting in .git/lfs/objects
// still printed `-` because its file had not been merged yet. Trusting the
// marker made this report every object as missing on every poll, block every
// merge, and break the repositories it was written to fix.
//
// So the oids come from ls-files and the ANSWER comes from the object store,
// whose location is asked of `git lfs env` rather than assumed — `lfs.storage`
// relocates it, and LocalMediaDir is what git-lfs itself resolves it to.
//
// `available: false` means git-lfs could not be asked at all — not installed,
// or not a repo it can read. The caller then proceeds exactly as it did before
// any of this existed, because nothing here can help it.
export async function missingObjects(folder, ref) {
    let listed
    try {
        listed = await git.run(folder, ['lfs', 'ls-files', '--long', ref])
    } catch (err) {
        return { available: false, missing: [], reason: err.stderr || err.message }
    }

    const wanted = []
    for (const line of listed.split('\n')) {
        // The path may contain spaces, so only the first two fields are split.
        const match = /^([0-9a-f]+)\s+[*-]\s+(.*)$/.exec(line.trim())
        if (match) wanted.push({ oid: match[1], path: match[2] })
    }
    // No LFS here. The overwhelmingly common case, and it costs one command.
    if (!wanted.length) return { available: true, missing: [] }

    let mediaDir
    try {
        mediaDir = await localMediaDir(folder)
    } catch (err) {
        return { available: false, missing: [], reason: err.stderr || err.message }
    }
    if (!mediaDir) return { available: false, missing: [], reason: 'git lfs env named no LocalMediaDir' }

    const missing = []
    for (const object of wanted) {
        if (!existsSync(objectPath(mediaDir, object.oid))) missing.push(object)
    }
    return { available: true, missing }
}

// git-lfs stores an object at <media>/<oid[0:2]>/<oid[2:4]>/<oid>.
export function objectPath(mediaDir, oid) {
    return path.join(mediaDir, oid.slice(0, 2), oid.slice(2, 4), oid)
}

async function localMediaDir(folder) {
    const out = await git.run(folder, ['lfs', 'env'])
    const match = /^LocalMediaDir=(.*)$/m.exec(out)
    return match ? match[1].trim() : null
}

// Remotes to try, best first. Derived, never assumed: the constraint is that
// `origin` may be either scheme, so the choice is made from the URLs that are
// actually configured.
//
//   1. what the operator named (`lfsRemote`) — explicit beats clever
//   2. any SSH remote — key auth is what a daemon has
//   3. the remote being merged — no better than today, but no worse
//
// Deliberately not "then every other remote": a second HTTPS remote is no
// likelier to hold credentials than the first, and trying it costs a network
// timeout per poll.
export async function candidateRemotes(folder, { configured, mergeRemote = 'origin' } = {}) {
    const names = await git.remotes(folder)
    const ordered = []
    const add = (name) => {
        if (name && names.includes(name) && !ordered.includes(name)) ordered.push(name)
    }
    add(configured)
    const urls = await Promise.all(names.map(async (name) => ({ name, url: await git.remoteUrl(folder, name) })))
    for (const { name, url } of urls) if (isSshUrl(url)) add(name)
    add(mergeRemote)
    return ordered
}

/**
 * Ensure every LFS object `ref` needs is in the local cache.
 *
 * Returns { ready: true, ... } when the merge can safely proceed — including
 * when there is no LFS here at all, which is most repositories.
 * Returns { ready: false, missing, tried } when it cannot be made safe.
 *
 * Never throws: its caller is a poll timer, and the whole module exists to
 * keep that timer from doing damage.
 */
export async function ensureObjects(folder, ref, { configured, mergeRemote = 'origin', token, logger } = {}) {
    const before = await missingObjects(folder, ref)
    if (!before.available) return { ready: true, reason: 'lfs-unavailable' }
    if (!before.missing.length) return { ready: true, missing: [] }

    const remotes = await candidateRemotes(folder, { configured, mergeRemote })
    const tried = []
    for (const remote of remotes) {
        try {
            await git.lfsFetch(folder, remote, ref, { token })
        } catch (err) {
            tried.push(`${remote}: ${lastLine(err.stderr || err.message)}`)
            continue
        }
        // A fetch that resolved the wrong ref exits ZERO and transfers
        // nothing, so the only honest confirmation is to ask again. This is
        // the trap that made the manual recovery look like a git-lfs bug:
        // `git lfs fetch <remote> production` resolves `production` to the
        // LOCAL branch — still the old commit, carrying none of the new
        // pointers — reports success, and fetches nothing. The remote-tracking
        // ref is the one that has them.
        const after = await missingObjects(folder, ref)
        if (!after.missing.length) {
            logger?.info('git: fetched %d LFS object(s) for %s from %s', before.missing.length, ref, remote)
            return { ready: true, remote, fetched: before.missing.length }
        }
        tried.push(`${remote}: fetched, ${after.missing.length} object(s) still missing`)
    }
    return { ready: false, missing: before.missing, tried }
}

const lastLine = (text) => String(text).trim().split('\n').pop().trim()
