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
import { changeSetTrailers } from './changeset-commit.js'
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
export async function commitAndPushWriteBranch(
    folder,
    // The callbacks are AWAITED. They record the outcome in the change-set
    // log, which is a database write now rather than a synchronous one, and a
    // promise started here and not waited for would still be in flight when
    // the pass ends — leaving a committed set looking pending and re-committed
    // on the next pass.
    { paths, writeBranch, message, author, token, changeSets = [], reserved = [], onCommitted, onFailed, onSettled },
) {
    const porcelain = await git.statusPorcelain(folder, paths)
    if (!porcelain) {
        // Nothing dirty anywhere — so every claimed set has already had its
        // effect cancelled or committed by something else, and none of them
        // has anything left to write.
        //
        // Returning here without saying so is what left them claimed forever:
        // the loop below never ran, no callback fired, and the caller logged
        // "N change set(s), 0 committed, 0 failed" every pass — true, and
        // indistinguishable from a scheduler that was not running at all.
        for (const set of changeSets) await onSettled?.(set.id, 'empty')
        return { committed: false, pushed: false }
    }

    let committedAny = false

    // Claimed writes first, each set its own commit staged to exactly the
    // paths that set wrote.
    //
    // Staging by FOLDER instead would sweep in whatever else happened to be
    // dirty — a document created through the API a second earlier lands in the
    // agent's commit, and undoing the agent then deletes that document. The
    // commit's contents have to match its label, or the label is a lie that
    // only shows up at undo time.
    for (const set of changeSets) {
        // Every claimed set leaves this loop through exactly one callback.
        // Two paths used to fall out silently, and a set that reaches neither
        // is re-claimed on every pass forever — reporting a null commit that
        // reads as a stalled pipeline when the pass is running correctly and
        // has nothing to do.
        const scoped = withinPaths(set.paths, paths)
        if (!scoped.length) {
            // Wrote only outside the folders this instance manages. Another
            // instance may own those paths; this one is finished with it.
            await onSettled?.(set.id, 'out-of-scope')
            continue
        }
        // Each set stands alone. One that cannot be committed — a path git
        // refuses, a lock, a hook that rejects it — must not take every later
        // set with it, or a single bad change freezes the log for everything
        // that follows and every one of them reads as merely pending.
        try {
            try {
                await git.addPaths(folder, scoped)
            } catch (err) {
                // `git add` refuses a pathspec matching nothing. That is the
                // same "nothing to write" as an empty diff, not a failure: the
                // set created files and something removed them again before
                // the pass ran, so there is neither a file to stage nor a
                // tracked deletion to record.
                if (!/did not match any files/i.test(err?.stderr ?? err?.message ?? '')) throw err
                await onSettled?.(set.id, 'empty')
                continue
            }
            if (!(await git.hasStagedChanges(folder, scoped))) {
                // Nothing to write. The set's changes cancelled out — an undo
                // of a create, a probe that added and removed its own files —
                // so git makes no commit, correctly. Done, not pending, and
                // not an error.
                await onSettled?.(set.id, 'empty')
                continue
            }
            await git.commit(folder, changeSetMessage(set, scoped), { author })
            committedAny = true
            // The sha is what an undo reverts FROM. Reported back so the
            // engine's log can say what each set maps to, which is the
            // difference between "no such change set" and "recorded, but
            // nothing has committed it".
            await onCommitted?.(set.id, await git.revParse(folder, 'HEAD'))
        } catch (err) {
            await onFailed?.(set.id, err)
            // Unstage, so a half-staged set does not ride along in the sweep
            // commit and get attributed to nobody.
            try { await git.run(folder, ['reset', '-q', 'HEAD', '--', ...scoped]) } catch { /* nothing staged */ }
        }
    }

    // Then everything still dirty and unclaimed: API writes, human edits, a
    // set whose attribution was lost to a crash. Unattributed and therefore
    // not undoable, but never dropped.
    const remaining = await git.statusPorcelain(folder, paths)
    if (!remaining) {
        return committedAny
            ? { committed: true, pushed: await pushWriteBranch(folder, { writeBranch, token }) }
            : { committed: false, pushed: false }
    }
    const fileCount = remaining.split('\n').filter(Boolean).length

    // The sweep takes everything unclaimed — but NOT what a change set still
    // open has written. That work belongs to a request that has not finished
    // yet; committing it here would attribute it to nobody and leave the set
    // with an empty diff, which reads as "this change did nothing" about a
    // change that is already in git.
    await git.addAll(folder, paths, { exclude: reserved })
    if (!(await git.hasStagedChanges(folder, paths))) {
        // hasChanges() can be true from untracked files git add didn't
        // end up staging as a diff from HEAD in edge cases (e.g. a
        // file that matches .gitignore was force-added) — defensive,
        // should not normally happen.
        return committedAny
            ? { committed: true, pushed: await pushWriteBranch(folder, { writeBranch, token }) }
            : { committed: false, pushed: false }
    }
    const resolvedMessage = typeof message === 'function' ? message({ fileCount }) : message
    await git.commit(folder, resolvedMessage, { author })

    return { committed: true, pushed: await pushWriteBranch(folder, { writeBranch, token }) }
}

// Only the paths this instance is scoped to. A change set can span
// collections this git instance does not manage; those stay for whichever
// instance does own them, rather than being committed here.
function withinPaths(candidates, paths) {
    if (!paths?.length) return candidates
    return candidates.filter(rel => paths.some(p => rel === p || rel.startsWith(`${p.replace(/\/$/, '')}/`)))
}

// Subject is the caller's own summary, so `git log --oneline` reads as a list
// of what was asked for. Trailers carry the machine-readable half.
function changeSetMessage(set, scoped) {
    const subject = set.summary?.trim().split('\n')[0]
        || `content: ${scoped.length} file(s) via mikser`
    return `${subject}\n\n${changeSetTrailers(set)}`
}

async function pushWriteBranch(folder, { writeBranch, token }) {
    try {
        await git.push(folder, writeBranch, { token })
        return true
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
        return true
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

    // Ask before pushing.
    //
    // This function merges immediately after opening the PR, which is exactly
    // when the forge has not finished computing mergeability. Both Gitea and
    // GitHub answer that with a retry signal — "Please try again later",
    // `mergeable: null` — and it used to come back through the same channel as
    // a conflict and end the pipeline. One cheap GET turns the race into a
    // wait.
    const state = adapter.readPR
        ? await adapter.readPR({ apiBase, owner, repo, number: pr.number, token, fetchImpl })
        : null

    // Merged out of band: by a human unblocking this very condition, or by
    // another instance sharing the branch. Converging and reporting success is
    // the honest answer — the work IS promoted — and attempting the merge
    // again would fail for a reason that means nothing.
    if (state?.merged) {
        await converge(folder, { writeBranch, targetBranch, token })
        return { promoted: true, prUrl: pr.url }
    }

    if (state && state.mergeable === null) {
        return {
            promoted: false,
            transient: true,
            prUrl: pr.url,
            reason: `mergeability of #${pr.number} not computed yet`,
        }
    }

    const result = await adapter.mergePR({ apiBase, owner, repo, number: pr.number, token, fetchImpl })

    if (!result.merged) {
        return {
            promoted: false,
            reason: result.reason,
            transient: result.transient === true,
            prUrl: pr.url,
        }
    }

    await converge(folder, { writeBranch, targetBranch, token })
    return { promoted: true, prUrl: pr.url }
}

// The target branch just advanced past the write branch's old tip (via a
// merge commit or squash). Pull the write branch up to match so the next
// commit does not keep re-diffing against an increasingly stale base.
// force-with-lease is safe here — this branch is exclusively bot-written, so
// nothing else's history is at risk, and it still refuses if the remote moved
// unexpectedly since our last fetch.
async function converge(folder, { writeBranch, targetBranch, token }) {
    await git.fetch(folder, { token })
    await git.resetHard(folder, `origin/${targetBranch}`)
    await git.push(folder, writeBranch, { token, force: true })
}

// Promote whatever is outstanding, without needing a commit first.
//
// The sync pass promotes only in the moment after it commits, so a promote
// that failed for a transient reason was never revisited: retrying required
// another edit, and an editor who has finished editing never supplies one.
// The write branch stayed ahead of the target with an open, mergeable PR —
// the site serving the change, the branch that defines what is deployed not
// carrying it, and one rate-limited yellow line as the only trace.
//
// So the condition to act on is "the write branch is ahead of the target",
// not "we just committed". Answered from the remote-tracking refs, because
// what matters is what the forge can see.
//
// Returns null when there is nothing outstanding, otherwise the promote
// result with `ahead` attached.
export async function promotePending(folder, options) {
    const { writeBranch, targetBranch, token } = options
    await git.fetch(folder, { token })
    const ahead = await git.commitsAhead(folder, `origin/${writeBranch}`, `origin/${targetBranch}`)
    if (!ahead) return null
    const result = await promote(folder, options)
    return { ahead, ...result }
}

// How loudly to say a promote did not happen.
//
// Three outcomes, because there are three situations and they used to share
// one voice:
//
//   quiet  the forge said "ask again" and the poll will. Saying so every 30
//          seconds trains the reader to ignore the channel, which is how the
//          real one gets missed.
//   warn   a conflict, a protected branch, a required review. A human has to
//          look, and the existing rate limiting keeps it from repeating.
//   error  the write branch has been ahead of the target for long enough that
//          this is a broken pipeline, not a slow one — the one condition where
//          the site and the repository disagree about what the site is. A
//          transient reason that has persisted this long is not transient.
//
// Pure, so the escalation can be tested without a forge, a clock or a plugin.
export function promoteEscalation({ transient, aheadSince, now = Date.now(), stuckAfterMs }) {
    const stuckFor = aheadSince == null ? 0 : now - aheadSince
    if (stuckFor >= stuckAfterMs) return 'error'
    return transient ? 'quiet' : 'warn'
}
