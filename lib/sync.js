// Orchestrates one sync pass: commit whatever's on disk to the write
// branch (always — this is the durable log, it must never block),
// then try to promote the write branch into the target branch (only
// when the caller has already determined the last cycle was green).
//
// Two promotion mechanisms:
//   - forge 'github' | 'gitea': open (or reuse) a PR write→target and
//     attempt to merge it. Conflict or any other failure just leaves
//     the PR open — never a crash, never data loss, always visible.
//   - forge 'none': a direct fast-forward push write:target. Works
//     against any bare remote with no API at all. If target has
//     diverged, the push is rejected (also not a crash) and everything
//     stays queued on the write branch until a human intervenes.

import * as git from './git.js'
import * as github from './forge/github.js'
import * as gitea from './forge/gitea.js'

const ADAPTERS = { github, gitea }

// Commit whatever's currently on disk and push it to the write branch.
// Returns { committed: boolean, pushed: boolean }. Never throws for
// "nothing to commit" — that's the common, expected case on a quiet
// cycle. Retries the push once after a pull --rebase-equivalent
// (fetch + reset onto the remote tip, since this branch is bot-owned
// and a local commit on top of a stale base is fine to replay) if the
// initial push is rejected as non-fast-forward — covers the case
// where an inbound pull (lib/inbound.js) advanced origin/<writeBranch>
// between this cycle's fetch and its push.
// `paths` scopes every git operation here to those pathspecs (relative
// to `folder`, the working folder / repo root) — see git.js's
// pathspecArgs. This is the hard boundary that lets mikser.config.js,
// node_modules/, runtime/, out/, and .env live in the SAME checkout
// this plugin manages without ever being staged or committed by it.
//
// `message` is a string or a function receiving { fileCount } (from
// `git status --porcelain`'s line count, computed before staging) and
// returning a string — a count rather than a file list, since a full
// list of paths in a commit message gets unwieldy past a handful of
// files and git status is cheap to re-derive if anyone needs detail.
export async function commitAndPushWriteBranch(folder, { paths, writeBranch, message, author, token }) {
    const porcelain = await git.statusPorcelain(folder, paths)
    if (!porcelain) return { committed: false, pushed: false }
    const fileCount = porcelain.split('\n').filter(Boolean).length

    await git.addAll(folder, paths)
    if (!(await git.hasStagedChanges(folder, paths))) {
        // hasChanges() can be true from untracked files git add didn't
        // end up staging as a diff from HEAD in edge cases (e.g. a
        // file that matches .gitignore was force-added) — defensive,
        // should not normally happen.
        return { committed: false, pushed: false }
    }
    const resolvedMessage = typeof message === 'function' ? message({ fileCount }) : message
    await git.commit(folder, resolvedMessage, { author })

    try {
        await git.push(folder, writeBranch, { token })
        return { committed: true, pushed: true }
    } catch (err) {
        if (!git.isNonFastForwardError(err)) throw err
        // The remote write branch moved (an inbound pull landed
        // between our last fetch and now). Rebase our new commit onto
        // the fresh remote tip and retry once. This branch is
        // exclusively bot-written, so replaying our commit on top of
        // the latest remote state is always safe — there's no other
        // writer's history to preserve alongside it beyond what
        // inbound sync already merged in.
        await git.fetch(folder, { token })
        await git.run(folder, ['rebase', `origin/${writeBranch}`])
        await git.push(folder, writeBranch, { token })
        return { committed: true, pushed: true }
    }
}

// Attempt to promote the write branch into the target branch. Called
// only when the caller has confirmed the cycle is green — this
// function does not itself check for render/postprocess failures.
//
// Returns { promoted: boolean, reason?, prUrl? }.
export async function promote(folder, {
    forge, targetBranch, writeBranch, token,
    owner, repo, apiBase, prTitle, fetchImpl,
}) {
    if (forge === 'none') {
        try {
            await git.push(folder, `${writeBranch}:${targetBranch}`, { token })
            return { promoted: true }
        } catch (err) {
            if (!git.isNonFastForwardError(err)) throw err
            return {
                promoted: false,
                reason: `${targetBranch} has diverged from ${writeBranch}; fast-forward push rejected. ` +
                    `Configure a forge adapter (github/gitea) to get a pull request here instead of a ` +
                    `manual merge, or merge ${writeBranch} into ${targetBranch} by hand.`,
            }
        }
    }

    const adapter = ADAPTERS[forge]
    if (!adapter) throw new Error(`git: unknown forge "${forge}" (expected github, gitea, or none)`)

    const pr = await adapter.ensurePR({
        apiBase, owner, repo, head: writeBranch, base: targetBranch, title: prTitle, token, fetchImpl,
    })
    const result = await adapter.mergePR({ apiBase, owner, repo, number: pr.number, token, fetchImpl })

    if (!result.merged) {
        return { promoted: false, reason: result.reason, prUrl: pr.url }
    }

    // Converge: the target branch just advanced past the write
    // branch's old tip (via a merge commit or squash). Pull the write
    // branch up to match so next cycle's commit doesn't keep re-diffing
    // against an increasingly stale base. force-with-lease is safe here
    // — this branch is exclusively bot-written, nothing else's history
    // is at risk, and --force-with-lease still refuses if the remote
    // moved unexpectedly since our last fetch.
    await git.fetch(folder, { token })
    await git.resetHard(folder, `origin/${targetBranch}`)
    await git.push(folder, writeBranch, { token, force: true })
    return { promoted: true, prUrl: pr.url }
}
