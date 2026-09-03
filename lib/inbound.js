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
export async function pullInbound(folder, { writeBranch, targetBranch, token, logger }) {
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
        try {
            await git.mergeBranch(folder, `origin/${ref}`)
        } catch (err) {
            // A failed abort would throw straight past this handler and
            // become the fatal rejection the fetch guard above exists to
            // prevent. Report it instead: the folder is then in a merge
            // state a human has to look at, which is worth saying loudly.
            try {
                await git.abortMerge(folder)
            } catch (abortErr) {
                logger?.error(
                    'git: inbound merge of origin/%s conflicted AND `git merge --abort` failed — %s. ' +
                    'The working folder is mid-merge and may contain conflict markers; mikser will render them as content. '
                    + 'Resolve manually before the next cycle.',
                    ref, abortErr.stderr || abortErr.message,
                )
                return { merged: false, conflictedRef: ref, abortFailed: true, reason: abortErr.stderr || abortErr.message }
            }
            logger?.error(
                'git: inbound merge of origin/%s conflicted — aborted, working folder left untouched. ' +
                'Resolve manually: cd <folder> && git merge origin/%s (or origin/%s) and fix the conflicts. %s',
                ref, writeBranch, targetBranch, err.stderr || err.message,
            )
            return { merged: false, conflictedRef: ref, reason: err.stderr || err.message }
        }
    }
    return { merged: true, unpushed }
}
