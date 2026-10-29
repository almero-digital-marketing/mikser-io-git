// Pull remote changes into the working folder. Two things can have
// moved on the remote since our last fetch:
//   - the write branch itself (a human pushed directly to it instead
//     of going through the CMS — discouraged but not prevented)
//   - the target branch (a promotion merged, or a human pushed/merged
//     directly to it)
// Both are merged in sequentially (not as one octopus merge) so a
// conflict is attributable to a specific branch and doesn't abort a
// merge that would otherwise have succeeded.
//
// On ANY conflict, the merge is aborted immediately — never left
// half-applied. This folder is mikser's live working copy; leaving
// conflict markers in a file would mean the render pipeline reads
// "<<<<<<< HEAD" as page content on the next cycle. Abort-and-log is
// the only acceptable outcome here.
//
// Note: this module performs the merge, and pushes any write-branch commits an
// earlier failure left behind (see the backlog check below). It doesn't need to
// wake mikser's watch loop itself — `git merge` writes real files via
// normal filesystem writes, which the file source's own chokidar
// watcher already sees as ordinary 'change' events (same as a human
// editing a file), and manager.js's watch() wakes the process loop
// from that automatically.

import * as git from './git.js'
import { ensureObjects } from './lfs.js'

// The first few, by name. A refusal can list a whole folder, and a log line
// that long gets truncated before the advice at its end.
function fileList(files, shown = 5) {
    const named = files.slice(0, shown).join(', ')
    return files.length > shown ? `${named} and ${files.length - shown} more` : named
}

const agreement = files => files.length === 1 ? ['is', 'it'] : ['are', 'them']

// Never throws. Every caller is a timer, and a timer callback that
// rejects takes the whole process down: Node has treated an unhandled
// rejection as fatal since v15, mikser installs no process-level handler,
// and the poll runs every few minutes for the life of a watch server. A
// network blip, a DNS failure or an expired token would kill the build and
// the site, and under a supervisor it becomes a restart loop.
//
// So the outcome is always a returned shape. A fetch that fails is the same
// class of event as a merge that conflicts — remote trouble, reported, try
// again next tick — and it is reported the same way.
export async function pullInbound(folder, { writeBranch, targetBranch, paths, token, lfsRemote, author, logger }) {
    try {
        await git.fetch(folder, { token })
    } catch (err) {
        // Nothing was touched: fetch writes only to remote-tracking refs,
        // and a failed one leaves even those alone.
        logger?.warn(
            'git: inbound fetch failed — %s. Working folder untouched; retrying on the next poll.',
            err.stderr || err.message,
        )
        return { merged: false, fetchFailed: true, reason: err.stderr || err.message }
    }

    // Commits that were committed here and never reached the forge.
    //
    // pushWriteBranch runs from the COMMIT path only, so a push that fails —
    // an expired token, a network blip — leaves its commits behind and nothing
    // looks at them again until the next edit happens to succeed. On lmed that
    // ran for weeks: the token 401'd, every poll logged a fetch failure, and
    // 113 commits of editors' work sat on the container with no copy anywhere
    // else. The site served fine, pm2 said online, the tree was clean.
    //
    // The poll is the only thing that runs on its own, so the backlog is
    // checked here, and pushed if it can be. That makes recovery automatic the
    // moment credentials work again, instead of waiting for someone to save a
    // file.
    let unpushed = 0
    try {
        unpushed = await git.commitsAhead(folder, writeBranch, `origin/${writeBranch}`)
        if (unpushed > 0) {
            await git.push(folder, writeBranch, { token })
            logger?.info(
                'git: pushed %d commit(s) that an earlier failure had left behind on %s',
                unpushed, writeBranch)
            unpushed = 0
        }
    } catch (err) {
        // Coded, so it registers as a FAULT and is deduped rather than
        // repeating every poll: this is work that exists in exactly one place,
        // and saying so once per build is the point.
        logger?.error(
            { code: 'git-unpushed', writeBranch, unpushed },
            'git: %d commit(s) on %s have never reached the remote — %s. '
            + 'They exist only in this working folder; losing it loses them. '
            + 'Nothing else will retry until an edit lands.',
            unpushed, writeBranch, err.stderr || err.message)
    }

    for (const ref of [writeBranch, targetBranch]) {
        const remoteRef = `origin/${ref}`

        // Nothing inbound on this branch — skip it entirely. Most polls land
        // here, and it is what keeps the LFS check below off the hot path:
        // `git lfs ls-files` walks the ref's tree, which on a media-heavy
        // repository is not free every thirty seconds.
        let incoming = 0
        try {
            incoming = await git.commitsAhead(folder, remoteRef, 'HEAD')
        } catch {
            // Can't tell — a shallow clone, a ref that is not there yet.
            // Fall through and let the merge be the judge, as before.
            incoming = 1
        }
        if (incoming === 0) continue

        // A merge that cannot finish must not START.
        //
        // Checking out an LFS-tracked file runs the smudge filter, which
        // resolves its endpoint from `origin` — and an HTTPS origin with no
        // stored credentials fatals on the username prompt. By then the merge
        // has already written the incoming commit's other files, so the tree
        // carries half of it: HEAD unmoved, a sibling edit applied, the media
        // absent, and no MERGE_HEAD for `--abort` to use. That half state is
        // indistinguishable from an editor's uncommitted work, so the sync
        // pass commits it and the promote carries a tree WITHOUT the new
        // media to the target branch.
        //
        // See lib/lfs.js. Objects first, merge second.
        const lfs = await ensureObjects(folder, remoteRef, {
            configured: lfsRemote, mergeRemote: 'origin', token, logger,
        })
        if (!lfs.ready) {
            logger?.error(
                { code: 'git-lfs-unfetchable', ref, missing: lfs.missing.length },
                'git: %s needs %d Git-LFS object(s) this host cannot fetch, so the merge was NOT started — '
                + 'beginning it would leave the working folder holding half the commit, with no MERGE_HEAD to '
                + 'abort. Nothing was touched and nothing will be promoted until it resolves. '
                + 'Give the plugin an `lfsRemote` that can serve LFS (an SSH remote authenticates with a key), '
                + 'or populate the cache by hand: cd <folder> && git lfs fetch <remote> %s. Tried — %s. First missing: %s',
                remoteRef, lfs.missing.length, remoteRef,
                lfs.tried.join('; ') || '(no usable remote)',
                lfs.missing.slice(0, 3).map(object => object.path).join(', '),
            )
            return { merged: false, lfsBlockedRef: ref, missingObjects: lfs.missing, reason: 'lfs objects unavailable' }
        }

        try {
            await git.mergeBranch(folder, remoteRef, { author })
        } catch (err) {
            // A failed abort would throw straight past this handler and
            // become the fatal rejection the fetch guard above exists to
            // prevent. Report it instead: the folder is then in a merge
            // state a human has to look at, which is worth saying loudly.
            // "Conflicted" was asserted rather than checked, and the two
            // failures need different words. A conflict leaves MERGE_HEAD and
            // is abortable; anything else — a smudge filter that fatals, a
            // dirty tree refusing the merge — does not, and calling it a
            // conflict sends the reader looking for conflict markers that are
            // not there.
            // Asked BEFORE the abort, because the abort destroys the
            // evidence. A conflict leaves MERGE_HEAD; a merge that died in
            // the checkout — an LFS smudge filter that cannot authenticate —
            // never wrote one.
            const conflicted = await git.inMerge(folder)
            await git.abortMerge(folder)
            // Only true once the tree is actually back. Saying "working
            // folder left untouched" over a half-applied merge is what let
            // the damage through: it reads as "nothing to do here".
            const dirty = await git.hasChanges(folder)

            if (conflicted) {
                logger?.error(
                    'git: inbound merge of %s conflicted — aborted, working folder left untouched. '
                    + 'Resolve manually: cd <folder> && git merge origin/%s (or origin/%s) and fix the conflicts. %s',
                    remoteRef, writeBranch, targetBranch, err.stderr || err.message,
                )
                return { merged: false, conflictedRef: ref, reason: err.stderr || err.message }
            }

            // Refused before it started, so the generic words below are
            // wrong in the one place that matters: there is no half-applied
            // commit to compare against, only files in the way. And a file
            // outside `paths` is never committed by the sync pass, so the
            // refusal repeats every poll until a person clears it — on a
            // live deployment that held two deploys while the site served
            // the old build, with a log naming neither the file nor the fix.
            const refusal = git.mergeRefusal(err)
            if (refusal) {
                const files = [...refusal.modified, ...refusal.untracked]
                const outside = files.filter(file => !git.withinPaths([file], paths).length)
                const inside = files.filter(file => !outside.includes(file))
                const blocking = [
                    refusal.modified.length && `uncommitted edits to ${fileList(refusal.modified)}`,
                    refusal.untracked.length && `untracked ${fileList(refusal.untracked)}, which the commit adds`,
                ].filter(Boolean).join(' and ')
                const clear = []
                if (outside.length) {
                    const [is, it] = agreement(outside)
                    clear.push(`${fileList(outside)} ${is} outside \`paths\`, so this plugin will never commit ${it}: `
                        + `a person has to commit or discard ${it} in the folder `
                        + '(git diff -- <file>, then commit, or git checkout -- <file>; delete an untracked one).')
                }
                if (inside.length) {
                    const [is, it] = agreement(inside)
                    clear.push(`${fileList(inside)} ${is} inside \`paths\`, so the next green cycle commits ${it} `
                        + 'and the merge after that is a real one — which conflicts if the incoming commit changed '
                        + 'the same lines.')
                }
                logger?.error(
                    { code: 'git-merge-blocked', ref, files, outside },
                    'git: inbound merge of %s refused — it would overwrite %s. Git checks every file before it writes '
                    + 'any, so nothing was applied: the working folder is exactly as it was. %s '
                    + 'Nothing will be promoted until this resolves.',
                    remoteRef, blocking, clear.join(' '),
                )
                return {
                    merged: false, failedRef: ref, dirty, blockedBy: files,
                    reason: `git refused the merge: it would overwrite ${blocking}`,
                }
            }

            logger?.error(
                { code: 'git-merge-failed', ref, dirty },
                'git: inbound merge of %s FAILED without conflicting, so there was no merge to abort — %s. '
                + 'The working folder %s. Nothing will be promoted until this resolves.',
                remoteRef, err.stderr || err.message,
                dirty
                    ? 'has uncommitted changes, which may be part of the commit the merge half-applied — '
                      + 'compare them against the incoming commit before letting anything commit them'
                    : 'is clean',
            )
            return { merged: false, failedRef: ref, dirty, reason: err.stderr || err.message }
        }
    }
    return { merged: true, unpushed }
}
