// First-connect decision logic for the working folder — the checkout
// root this plugin manages (see index.js: `folder` is always
// `runtime.options.workingFolder` now, not a per-collection subfolder).
//
// The one genuinely destructive moment in this plugin: attaching git to
// a folder that already has files but isn't a checkout. Neither "local
// wins" nor "remote wins" is a safe default — either could silently
// discard real content (whichever side loses gets overwritten on the
// very next sync). So the default is REFUSE: report what was found,
// change nothing, and point at the one-time manual recipe that attaches
// history without touching a single file. After that one-time step the
// folder is an ordinary checkout and this code never runs again.
//
// Because `folder` is the working folder, it will almost always
// already be non-empty (mikser.config.js, node_modules/, .env, ...) —
// so this REFUSE path is the common first-run case for a project
// that's never been under git before, not a rare edge case. The
// 'clone' path (folder absent or empty) only fires for something like
// a bare, freshly-provisioned directory that hasn't even been given a
// mikser.config.js yet.
//
// decideBootstrap is pure — plain booleans/strings in, a decision out —
// so the "what happens in every folder state" matrix is unit-testable
// without a filesystem or git binary. gatherFolderState/performBootstrap
// are the impure edges that feed it real values and act on its decision.

import { existsSync, readdirSync } from 'node:fs'
import * as git from './git.js'

// Normalize a git remote URL for comparison: strip protocol, trailing
// `.git`, and trailing slash, lowercase. Good enough to catch
// `https://github.com/org/repo` vs `https://github.com/org/repo.git`
// vs a trailing-slash variant — NOT a full SSH-vs-HTTPS equivalence
// check (e.g. `git@github.com:org/repo` vs `https://github.com/org/repo`
// won't match). Exact remote-string agreement in config is the
// supported path; this only smooths the most common cosmetic variants.
function normalizeRemote(url) {
    if (!url) return url
    return url
        .trim()
        .toLowerCase()
        .replace(/\.git\/?$/, '')
        .replace(/\/$/, '')
        .replace(/^[a-z]+:\/\//, '')
        .replace(/^[^@]+@/, '')   // strip a userinfo@ prefix if present
        .replace(':', '/')       // git@host:org/repo → host/org/repo
}

function urlsEquivalent(a, b) {
    return normalizeRemote(a) === normalizeRemote(b)
}

// Pure decision. Inputs describe the folder + repo state as already-
// observed facts; output is one of:
//   { action: 'clone',  reason }  — folder absent or empty; safe to clone into
//   { action: 'verify', reason }  — already a checkout of the right remote
//   { action: 'refuse', reason }  — anything ambiguous; do nothing
export function decideBootstrap({ folderExists, folderEmpty, isRepo, remoteUrl, expectedUrl }) {
    if (isRepo) {
        if (!remoteUrl) {
            return {
                action: 'refuse',
                reason: 'Working folder is already a git repository but has no "origin" remote configured. ' +
                    'Wire it by hand (`git remote add origin <url>`) so it matches the configured `url`.',
            }
        }
        if (!urlsEquivalent(remoteUrl, expectedUrl)) {
            return {
                action: 'refuse',
                reason: `Working folder's origin remote (${remoteUrl}) does not match the configured repo ` +
                    `(${expectedUrl}). Refusing to touch it — update the config or the remote so they agree.`,
            }
        }
        return { action: 'verify', reason: 'Working folder is already a checkout of the configured repo.' }
    }
    if (!folderExists || folderEmpty) {
        return {
            action: 'clone',
            reason: folderExists ? 'Working folder exists and is empty.' : 'Working folder does not exist yet.',
        }
    }
    return {
        action: 'refuse',
        reason: 'Working folder exists, has files, and is not a git repository. Refusing to guess whether ' +
            'local files or the remote should win — whichever loses gets silently overwritten on the next ' +
            'sync. Attach it by hand ONCE, from the working folder itself (this does not touch your files, ' +
            'only history):\n' +
            '    git init\n' +
            '    git remote add origin <url>\n' +
            '    git fetch origin\n' +
            '    git reset --mixed origin/<branch>\n' +
            'Then run `git status` — anything it reports as an untracked/modified file is the real ' +
            'divergence to resolve by hand before the plugin takes over.',
    }
}

// Gather the observed facts for decideBootstrap from the real folder.
export async function gatherFolderState(folder, expectedUrl) {
    const folderExists = existsSync(folder)
    const folderEmpty = folderExists ? readdirSync(folder).length === 0 : true
    const isRepo = folderExists && !folderEmpty && await git.isInsideWorkTree(folder)
    const remoteUrl = isRepo ? await git.remoteUrl(folder) : null
    return { folderExists, folderEmpty, isRepo, remoteUrl, expectedUrl }
}

// Act on a 'clone' decision: clone the repo, then ensure `writeBranch`
// exists locally (creating it from the freshly-cloned default branch
// and pushing it upstream if the remote doesn't have it yet either —
// the very first run on a brand-new content repo).
export async function performClone(folder, { url, token, targetBranch, writeBranch }) {
    await git.clone(url, folder, { token })
    await ensureWriteBranch(folder, { token, targetBranch, writeBranch })
}

// Act on a 'verify' decision: fetch, then ensure writeBranch exists and
// is checked out. Cheap and idempotent — safe to call on every restart.
export async function performVerify(folder, { token, targetBranch, writeBranch }) {
    await git.fetch(folder, { token })
    await ensureWriteBranch(folder, { token, targetBranch, writeBranch })
}

// Ensure the write branch exists (locally and on the remote) and is
// the currently checked-out branch. Three cases:
//   - already checked out locally → nothing to do
//   - exists locally, not checked out → check it out
//   - exists on the remote only → check it out tracking origin/<branch>
//   - exists nowhere → branch it from the current HEAD (the target
//     branch's tip on a fresh clone) and push it upstream immediately,
//     so `origin/<writeBranch>` exists from the very first cycle.
async function ensureWriteBranch(folder, { token, targetBranch, writeBranch }) {
    const current = await git.currentBranch(folder).catch(() => null)
    if (current === writeBranch) return

    if (await git.branchExistsLocal(folder, writeBranch)) {
        await git.checkoutBranch(folder, writeBranch)
        return
    }
    if (await git.branchExistsRemote(folder, writeBranch, { token })) {
        await git.checkoutBranch(folder, writeBranch, { create: true, startPoint: `origin/${writeBranch}` })
        return
    }
    // Brand new: branch from wherever HEAD is (the target branch on a
    // fresh clone) and publish it so the remote has it too.
    await git.checkoutBranch(folder, writeBranch, { create: true })
    await git.push(folder, `HEAD:${writeBranch}`, { token })
}
