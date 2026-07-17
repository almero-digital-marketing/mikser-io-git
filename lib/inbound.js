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
// Note: this module ONLY performs the merge. It doesn't need to wake
// mikser's watch loop itself — `git merge` writes real files via
// normal filesystem writes, which the file source's own chokidar
// watcher already sees as ordinary 'change' events (same as a human
// editing a file), and manager.js's watch() wakes the process loop
// from that automatically.

import * as git from './git.js'

export async function pullInbound(folder, { writeBranch, targetBranch, token, logger }) {
    await git.fetch(folder, { token })

    for (const ref of [writeBranch, targetBranch]) {
        try {
            await git.mergeBranch(folder, `origin/${ref}`)
        } catch (err) {
            await git.abortMerge(folder)
            logger?.error(
                'git: inbound merge of origin/%s conflicted — aborted, working folder left untouched. ' +
                'Resolve manually: cd <folder> && git merge origin/%s (or origin/%s) and fix the conflicts. %s',
                ref, writeBranch, targetBranch, err.stderr || err.message,
            )
            return { merged: false, conflictedRef: ref, reason: err.stderr || err.message }
        }
    }
    return { merged: true }
}
