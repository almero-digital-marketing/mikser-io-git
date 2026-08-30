// The undo surface, deliberately MCP-only.
//
// API and human writes are not attributed and are not undoable here. That is
// the scope, not a limitation to fix later: those callers have git, and an
// undo they could reach would be an undo able to remove work it never made.
// The change-set trailer is the permission boundary — nothing without one is
// reachable from these tools.

import { z } from 'zod'
import { recordChangeSetWrite } from 'mikser-io'

import { listChangeSets, previewUndo } from './undo.js'
import * as git from './git.js'

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

export function registerUndoTools(mcp, { folder, writeBranch, runtime, useLogger, isInert, sync, afterMs, maxWaitMs }) {
    if (!mcp) return
    const logger = useLogger?.()

    mcp.simpleTool(
        'mikser_changes',
        'List recent change sets — the units of work an agent can undo. Each is one request, however many files '
        + 'it wrote, with the summary given when it was made.\n\n'
        + 'Only agent writes appear. Documents created through the API and files edited by hand are committed too, '
        + 'but unattributed and deliberately not undoable from here — reverting them would remove work this tool '
        + 'has no claim on.',
        {
            limit: z.number().int().positive().max(50).optional()
                .describe('How many change sets to list, newest first. Default 20.'),
        },
        async ({ limit = 20 } = {}) => {
            if (isInert?.()) return fail('git: plugin is inert after a bootstrap refusal — no history to read.')
            try {
                const sets = await listChangeSets(folder, { limit })
                return ok({
                    count: sets.length,
                    changes: sets.map(set => ({
                        id: set.id,
                        summary: set.summary,
                        at: new Date(set.startedAt).toISOString(),
                        files: set.paths.length,
                        ...(set.principal ? { by: set.principal } : {}),
                        ...(set.undoOf ? { undoOf: set.undoOf } : {}),
                        // Absent until something has committed it. An agent
                        // seeing this null knows undo is not available YET,
                        // rather than discovering it at the refusal.
                        committed: set.recordedAs ? set.recordedAs.slice(0, 8) : null,
                        // Why there is no commit, when there is none. Without
                        // it, "finished with nothing to write" and "still
                        // waiting" are the same null.
                        ...(set.outcome && set.outcome !== 'committed' ? { outcome: set.outcome } : {}),
                        // A set that FAILED is not a set that is waiting.
                        // Without this the two are the same null, and a
                        // permanent failure reads as "any moment now" forever.
                        ...(set.commitError ? { commitError: set.commitError } : {}),
                    })),
                    next: 'Pass an `id` to mikser_undo with dryRun first — it reports whether the undo applies '
                        + 'cleanly and whether anything added since depends on what it would remove.',
                })
            } catch (err) {
                logger?.error('git: mikser_changes failed — %s', err.stderr || err.message)
                return fail(err.stderr || err.message)
            }
        },
    )

    mcp.simpleTool(
        'mikser_undo',
        'Take back one change set, keeping everything that happened after it.\n\n'
        + 'This is not a restore to a previous state: documents added through the API since, and edits made by '
        + 'hand, are kept. Only the named change set\'s contribution is removed, as an ordinary forward commit — '
        + 'so history is never rewritten, the deploy branch never has to be force-pushed, and the undo is itself '
        + 'an undoable change set.\n\n'
        + 'ALWAYS dryRun first. Two independent things can stop an undo, and they need different answers: a later '
        + 'edit to the same content makes it inapplicable (`conflict`), and a document added since that references '
        + 'something this undo REMOVES makes it destructive (`dangling`). The second is the dangerous one — git '
        + 'applies it cleanly and the site breaks anyway, which is why the reference graph is consulted rather '
        + 'than just the patch.',
        {
            id:     z.string().describe('Change set id, from mikser_changes.'),
            dryRun: z.boolean().optional().describe('Report what the undo would do and change nothing. Default true — pass false to actually apply it.'),
            force:  z.boolean().optional().describe('Apply even when the undo would leave references dangling. Never bypasses a conflict, which cannot be applied at all.'),
        },
        async ({ id, dryRun = true, force = false } = {}) => {
            if (isInert?.()) return fail('git: plugin is inert after a bootstrap refusal — refusing to touch the folder.')
            if (!id) return fail('id is required')
            try {
                const preview = await previewUndo(folder, { id, branch: writeBranch, runtime })
                if (!preview.ok) {
                    // A pending set is the common case, not an error: writes
                    // are committed after a quiet period, and an agent that
                    // asks the moment it writes is always inside it. Say how
                    // long, or "not yet" reads as "never".
                    if (preview.refused === 'not-yet-committed' && afterMs) {
                        return ok({
                            ...preview,
                            commitsAfter: `${Math.round(afterMs / 1000)}s of quiet`
                                + (maxWaitMs ? `, and at most ${Math.round(maxWaitMs / 1000)}s` : ''),
                            next: 'Wait for the sync pass and try again. The change is safe on disk either way — '
                                + 'this only means git has not been given it yet.',
                        })
                    }
                    return ok(preview)
                }

                const { patch, ...report } = preview
                if (dryRun) {
                    return ok({
                        ...report, dryRun: true,
                        wouldApply: preview.applies && (!preview.dangling.length || force),
                        next: preview.applies
                            ? 'Call again with dryRun: false to apply.'
                            : 'This one cannot be applied automatically. Say so plainly rather than trying '
                                + 'variations — the content it touched has moved on.',
                    })
                }

                // A patch that does not apply is refused outright. Attempting
                // it would leave the working folder half-changed, and for a
                // deployed site that means the build stops — an undo that
                // takes the site down is worse than the change it undoes.
                if (!preview.applies) {
                    return ok({ ...report, ok: false, refused: 'conflict' })
                }
                if (preview.dangling.length && !force) {
                    return ok({
                        ...report, ok: false, refused: 'would-dangle',
                        next: 'Pass force: true only if removing those references is intended.',
                    })
                }

                await git.applyPatch(folder, patch)

                // Recorded as its own change set so the commit carries a
                // trailer and the undo can itself be undone.
                const undoId = `undo-${id}-${Math.round(preview.set.at)}`
                for (const rel of preview.touched) {
                    recordChangeSetWrite({
                        changeSet: undoId,
                        summary: `Undo: ${preview.set.summary ?? id}`,
                        principal: 'agent',
                        undoOf: id,
                        uri: `${runtime.options.workingFolder}/${rel}`,
                    })
                }

                // The files are on disk now; the engine's watcher will pick
                // them up. Nudging the sync pass means the undo reaches the
                // remote without waiting for the next debounce window.
                //
                // Deliberately not awaited — a push over the network is not
                // something a tool call should block on — but never left as a
                // bare floating promise either: an unhandled rejection ends
                // the process. The caller guards it too; this is the second
                // layer, because being wrong here is fatal rather than noisy.
                try { Promise.resolve(sync?.()).catch(() => {}) } catch { /* sync threw synchronously */ }

                return ok({
                    ok: true, undone: id, changeSet: undoId,
                    summary: preview.set.summary,
                    touched: preview.touched,
                    removed: preview.removes,
                    // Says what HAS happened and what has not. The revert is
                    // on disk now; the commit, the push and the rebuild are a
                    // sync pass away, and an agent reporting "it is live" on
                    // the strength of this response would be wrong.
                    next: 'The files are reverted on disk. The commit, push and rebuild follow on the next sync '
                        + `pass — this call does not wait for them. Undo this undo with mikser_undo({ id: '${undoId}' }).`,
                })
            } catch (err) {
                logger?.error('git: mikser_undo failed — %s', err.stderr || err.message)
                return fail(err.stderr || err.message)
            }
        },
    )
}
