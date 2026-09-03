// mikser-io-git — two-way git sync for mikser-io.
//
// Model: the WORKING FOLDER itself is the checkout, on a dedicated
// write branch (default `mikser`) that this plugin owns exclusively.
// `paths` (relative to the working folder) names which collections'
// folders — documents, layouts, files, whatever an API/MCP call can
// reach — this plugin is allowed to commit; everything else in the
// working folder (mikser.config.js, node_modules/, runtime/, out/,
// .env) sits in the SAME checkout untouched, because every git
// operation is pathspec-scoped to exactly those folders (see
// lib/git.js's pathspecArgs / lib/sync.js). One checkout, one branch,
// any number of auto-committed collections sharing both — no more
// juggling a separate repo (or at least a separate branch name) per
// folder the way an earlier, per-folder-checkout design would have
// required.
//
// Every green cycle (no render/postprocess failure) commits + pushes
// whatever changed inside `paths` to the write branch — unconditionally,
// so an agent's work is never lost to a crash or a later red cycle —
// then tries to promote it into the target branch (default `main`) via
// a pull request (GitHub/Gitea) or a direct fast-forward push
// (`forge: 'none'`, any bare remote). A red cycle holds the promotion
// but the write-branch commit still happens on the next green cycle
// once the queued changes accumulate on disk — nothing here tracks a
// pending set separately from the filesystem itself. A promotion
// conflict just leaves the PR open; this plugin never resolves a
// conflict or picks a winner.
//
// Inbound: remote changes on either branch are pulled in on a poll
// timer (webhook delivery is NOT implemented — see README) and merged
// into the local write branch; a merge conflict aborts immediately so
// the working folder — mikser's live render source — never holds
// conflict-marker text as page content.
//
// First-connect safety: if the working folder already has files but
// isn't a git checkout, the plugin refuses to guess whether local or
// remote content should win (either default silently discards the
// other side on the very next sync) and logs the one-time manual
// recipe to attach history without touching a single file. In
// practice this is the common first-run path — the working folder
// almost always already has mikser.config.js, node_modules/, etc. in
// it by the time this plugin loads, so "clone into an empty folder"
// is the rare case, not the default one.
//
// This is meant for a deployment target this plugin (and mikser)
// exclusively manages — a server checkout, not a developer's actively-
// edited local clone. It checks out and holds the write branch in the
// ENTIRE working folder; running it against someone's local dev
// checkout would switch their active branch out from under them.

import { resolveConfig } from './lib/config.js'
import { gatherFolderState, decideBootstrap, performClone, performVerify } from './lib/bootstrap.js'
import { commitAndPushWriteBranch, promote, promotePending, promoteEscalation } from './lib/sync.js'
import { pullInbound } from './lib/inbound.js'
import { reduceDebounce, IDLE_DEBOUNCE_STATE } from './lib/debounce.js'
import { createGitQueue } from './lib/queue.js'

const REANNOUNCE_MS = 30 * 60 * 1000   // re-log a still-open conflict at most every 30 min
// How long the write branch may sit ahead of the target before it stops being
// a slow pipeline and becomes a broken one. The site serves the edit from the
// working folder while the branch that defines what is deployed does not carry
// it — so a rebuild from the target comes up without it, and the next push to
// the target reverts it, as a valid commit on a green build. That is the one
// condition where the site and the repository disagree about what the site is,
// and it earns an error rather than a rate-limited warning.
const AHEAD_STUCK_MS = 5 * 60 * 1000

// Run a timer body so that nothing it does can end the process.
//
// Both schedulers here fire for the life of a watch server, and an async
// callback that rejects is fatal — Node has treated an unhandled rejection
// as process-ending since v15, and mikser core installs no handler. The
// failure mode this prevents is a transient remote error taking down the
// build AND the site, and looping under a supervisor.
function withGuard(logger, what, fn) {
    Promise.resolve()
        .then(fn)
        .catch(err => logger?.error('git: %s failed — %s', what, err?.stderr || err?.message || err))
}


import { pendingChangeSets, markChangeSetsRecorded, markChangeSetFailed, markChangeSetSettled } from 'mikser-io'
import { registerUndoTools } from './lib/mcp.js'

export function git(options = {}) {
    const {
        url, paths, forge, targetBranch, writeBranch,
        token, message, author, afterMs, maxWaitMs, changeSetAfterMs, pollIntervalMs,
        owner, repo, apiBase,
    } = resolveConfig(options)

    return ({ runtime, onLoaded, onFinalize, useLogger, useJournal, constants: { OPERATION } }) => {
        // The checkout root is ALWAYS the working folder — there's no
        // per-instance subfolder checkout anymore. `paths` is what
        // scopes this instance's reach within it.
        const folder = runtime.options.workingFolder

        const enqueueGit = createGitQueue()
        let debounceState = IDLE_DEBOUNCE_STATE
        let timer = null
        let pollTimer = null
        let watchdog = null
        let lastPromoteFailureReason = null
        let lastPromoteFailureLoggedAt = 0
        // When the write branch was first seen ahead of the target and not
        // promoted. Cleared on every successful promote.
        let aheadSince = null
        let aheadReported = false
        let inert = false   // set true on a bootstrap refusal; the plugin stops touching the folder for the rest of this process

        async function runSyncPass(logger) {
            debounceState = IDLE_DEBOUNCE_STATE
            try {
                // Claimed sets are drained only once their paths are actually
                // committed. A set whose commit throws stays pending and is
                // retried next pass rather than silently losing attribution.
                // Only sets that are FINISHED. An open one still inside its
                // quiet period may still grow, and committing it now would
                // split one request across two commits — which then takes two
                // undos to take back.
                const now = Date.now()
                const claimed = (await pendingChangeSets()).filter(set =>
                    set.closed
                    || (set.updatedAt ?? set.startedAt) + changeSetAfterMs <= now
                    // The ceiling, enforced here too: a set that has waited
                    // this long is committed whether or not anything went
                    // quiet.
                    || set.startedAt + maxWaitMs <= now)
                const consumed = []
                const failed = []
                const settled = []
                // What a not-yet-ready set has written. Held back from the
                // sweep so the set can still commit it under its own name.
                const claimedIds = new Set(claimed.map(set => set.id))
                const reserved = (await pendingChangeSets())
                    .filter(set => !claimedIds.has(set.id))
                    .flatMap(set => set.paths)

                const { committed } = await commitAndPushWriteBranch(folder, {
                    paths, writeBranch, message, author, token,
                    changeSets: claimed, reserved,
                    onCommitted: (id, sha) => consumed.push({ id, sha }),
                    // Finished with nothing to write. Drained rather than
                    // retried: the diff is empty and will stay empty, so a
                    // retry costs a pass and leaves a null that looks like a
                    // fault.
                    onSettled: (id, reason) => settled.push({ id, reason }),
                    onFailed: (id, err) => {
                        failed.push({ id, err })
                        logger.warn('git: change set %s could not be committed — %s',
                            id, err?.stderr || err?.message || err)
                    },
                })

                // Recorded after the commit returns rather than from inside
                // its callbacks. The marks are async now, and a promise
                // started in a sync callback would still be in flight when the
                // pass ends — leaving a committed set looking pending, and
                // re-committed on the next pass.
                for (const { id, sha } of consumed) await markChangeSetsRecorded([id], sha)
                for (const { id, reason } of settled) await markChangeSetSettled(id, reason)
                for (const { id, err } of failed) await markChangeSetFailed(id, err)
                // Said every pass, so a stall is visible in the log instead of
                // inferred from a column of nulls.
                if (claimed.length) {
                    // Settled is reported too, or a pass that correctly had
                    // nothing to write logs "0 committed, 0 failed" — true,
                    // and indistinguishable from a scheduler that never ran.
                    logger.info('git: sync pass — %d change set(s), %d committed, %d settled, %d failed',
                        claimed.length, consumed.length, settled.length, failed.length)
                }
                if (!committed) return
                logger.info('git: committed + pushed to %s', writeBranch)

                const result = await promote(folder, {
                    forge, targetBranch, writeBranch, token, owner, repo, apiBase,
                    prTitle: `Promote ${writeBranch} → ${targetBranch}`,
                })
                reportPromote(logger, result)
            } catch (err) {
                logger.error('git: sync pass failed — %s', err.stderr || err.message)
            }
        }

        // One place both callers report through, so the sync pass and the poll
        // cannot drift into saying different things about the same condition.
        function reportPromote(logger, result) {
            if (result.promoted) {
                logger.info('git: promoted %s → %s', writeBranch, targetBranch)
                lastPromoteFailureReason = null
                aheadSince = null
                aheadReported = false
                return
            }

            aheadSince ??= Date.now()

            // A transient failure is the forge saying "ask again", and the
            // poll will. Saying so every 30 seconds would train the reader to
            // ignore the channel, which is how the real one gets missed — so
            // it stays quiet until it has actually been failing for a while,
            // and then it is not transient any more.
            const stuckFor = Date.now() - aheadSince
            const level = promoteEscalation({
                transient: result.transient, aheadSince, stuckAfterMs: AHEAD_STUCK_MS,
            })

            if (level === 'quiet') {
                logger.debug(
                    'git: promote %s → %s not ready yet — %s (retrying on the poll)',
                    writeBranch, targetBranch, result.reason)
                return
            }

            if (level === 'error' && !aheadReported) {
                // Coded, so it registers as a FAULT: a subsystem declaring it
                // cannot do its job, deduped and surfaced in --json and
                // mikser_ping rather than only in a log nobody is reading.
                logger.error(
                    { code: 'git-promote-stuck', writeBranch, targetBranch, prUrl: result.prUrl ?? null },
                    'git: %s has been ahead of %s for %d minute(s) and is not promoting — %s%s. '
                    + 'The site is serving edits this repository does not carry: a rebuild from %s comes up '
                    + 'without them, and the next push to %s reverts them.',
                    writeBranch, targetBranch, Math.round(stuckFor / 60000), result.reason,
                    result.prUrl ? ` (${result.prUrl})` : '', targetBranch, targetBranch)
                aheadReported = true
                lastPromoteFailureReason = result.reason
                lastPromoteFailureLoggedAt = Date.now()
                return
            }

            const changed = result.reason !== lastPromoteFailureReason
            const dueToReannounce = Date.now() - lastPromoteFailureLoggedAt > REANNOUNCE_MS
            if (changed || dueToReannounce) {
                logger.warn(
                    'git: could not promote %s → %s — %s%s',
                    writeBranch, targetBranch, result.reason,
                    result.prUrl ? ` (${result.prUrl})` : '',
                )
                lastPromoteFailureReason = result.reason
                lastPromoteFailureLoggedAt = Date.now()
            }
        }

        // Retry an outstanding promote, on the poll rather than on a commit.
        //
        // The condition is "the write branch is ahead of the target", which
        // survives the editor going home. Coupling it to "we just committed"
        // meant a transient failure was terminal in practice, because the
        // retry needed an edit that was never coming.
        async function retryPromote(logger) {
            const result = await promotePending(folder, {
                forge, targetBranch, writeBranch, token, owner, repo, apiBase,
                prTitle: `Promote ${writeBranch} → ${targetBranch}`,
            })
            if (!result) {
                // Nothing outstanding — the target contains everything.
                aheadSince = null
                aheadReported = false
                return
            }
            reportPromote(logger, result)
        }

        // When the earliest pending change set wants to be committed, or null
        // when none is pending. Closed sets are ready now; open ones once they
        // have been quiet for changeSetAfterMs.
        async function soonestChangeSetDeadline(now) {
            let soonest = null
            for (const set of await pendingChangeSets()) {
                const at = set.closed
                    ? now
                    // Whichever comes first: quiet since the set last grew, or
                    // the ceiling measured from when it started. The ceiling
                    // is what makes a busy server still commit, so it is a
                    // real bound here rather than a sentence in a description.
                    : Math.min((set.updatedAt ?? set.startedAt) + changeSetAfterMs, set.startedAt + maxWaitMs)
                if (soonest === null || at < soonest) soonest = at
            }
            return soonest
        }

        function scheduleFire(logger) {
            if (timer) clearTimeout(timer)
            const delay = Math.max(0, debounceState.fireAt - Date.now())
            timer = setTimeout(() => withGuard(logger, 'sync pass', () => enqueueGit(() => runSyncPass(logger))), delay)
            timer.unref?.()
        }

        // A tick that does not depend on a build cycle happening.
        //
        // scheduleFire is armed from onFinalize, so every re-arm needed a
        // cycle to run. A pass that threw, a queue that stalled, or simply no
        // further cycle left the loop with nothing scheduled and no way back —
        // one commit at startup and then silence, which is exactly what a dead
        // scheduler looks like from outside.
        //
        // This runs regardless, checks whether anything is owed, and is the
        // only thing that guarantees the ceiling is honoured: a set older than
        // maxWaitMs is committed whether or not the site ever went quiet.
        function startWatchdog(logger) {
            if (watchdog) return
            watchdog = setInterval(() => {
                if (inert) return
                withGuard(logger, 'sync watchdog', async () => {
                    const owed = await pendingChangeSets()
                    if (!owed.length) return
                    const now = Date.now()
                    const due = owed.some(set =>
                        set.closed
                        || (set.updatedAt ?? set.startedAt) + changeSetAfterMs <= now
                        || set.startedAt + maxWaitMs <= now)
                    if (due) await enqueueGit(() => runSyncPass(logger))
                })
            }, Math.max(1_000, Math.min(changeSetAfterMs, 30_000)))
            watchdog.unref?.()
        }

        onLoaded(async () => {
            const logger = useLogger()
            const state = await gatherFolderState(folder, url)
            const decision = decideBootstrap({ ...state, expectedUrl: url })

            if (decision.action === 'refuse') {
                logger.error('git: %s', decision.reason)
                inert = true
                return
            }
            try {
                if (decision.action === 'clone') {
                    logger.info('git: %s Cloning %s into %s.', decision.reason, url, folder)
                    await performClone(folder, { url, token, targetBranch, writeBranch })
                } else {
                    await performVerify(folder, { token, targetBranch, writeBranch })
                }
            } catch (err) {
                logger.error('git: bootstrap failed — %s', err.stderr || err.message)
                inert = true
                return
            }
            logger.info(
                'git: working folder ready — %s on branch %s (auto-committing %s, promotes to %s via %s)',
                folder, writeBranch,
                paths ? `[${paths.join(', ')}]` : 'the WHOLE working folder (no `paths` set — relying on .gitignore)',
                targetBranch, forge,
            )

            // Runs in watch mode only: a one-shot build syncs at the end of
            // its single cycle and then exits, so there is no later to guard.
            if (runtime.options.watch) startWatchdog(logger)

            // Undo is an MCP-only surface. API and human writes are not
            // attributed and are deliberately not undoable — those callers
            // have git, and an undo they could reach would be an undo that
            // could remove someone else's work. The tools declare that scope
            // themselves now, so registration is unconditional: there is no
            // mcp plugin to check for and no order to depend on.
            registerUndoTools({
                folder, writeBranch, runtime, useLogger,
                isInert: () => inert,
                // How long a write waits before it is committed. Reported
                // in the refusal, because "not committed yet" without a
                // duration reads as broken rather than as pending — and
                // the default is a full minute of quiet.
                afterMs, maxWaitMs,
                // Guarded, because the tool fires this without awaiting
                // it. An unhandled rejection has ended the process since
                // Node 15, and mikser installs no handler — the same
                // reasoning the inbound poll timer is wrapped for.
                sync: () => withGuard(useLogger(), 'undo sync', () => enqueueGit(() => runSyncPass(useLogger()))),
            })

            // Inbound polling — watch mode only; a one-shot build has no
            // "later" to pull into. Webhook delivery is not implemented
            // (see README); poll is the only supported inbound trigger.
            if (runtime.options.watch && pollIntervalMs > 0) {
                pollTimer = setInterval(() => {
                    if (inert) return
                    // Belt AND braces. pullInbound is written not to throw,
                    // but a timer callback is the one place where being
                    // wrong about that is fatal rather than noisy: Node has
                    // treated an unhandled rejection as process-ending since
                    // v15, and mikser installs no handler. Anything reaching
                    // here is a bug worth logging, not worth killing the
                    // build server for.
                    withGuard(logger, 'inbound poll', () => enqueueGit(async () => {
                        await pullInbound(folder, { writeBranch, targetBranch, token, logger })
                        // Same tick, same queue slot: whatever the pull just
                        // learned about the remote is what the promote should
                        // act on.
                        await retryPromote(logger)
                    }))
                }, pollIntervalMs)
                pollTimer.unref?.()
            }
        })

        onFinalize(async (signal) => {
            if (inert) return
            const logger = useLogger()

            const culprits = []
            for await (const { entity, output } of useJournal(
                'Git green-check',
                [OPERATION.RENDER, OPERATION.POSTPROCESS],
                signal,
            )) {
                if (signal.aborted) return
                if (output?.success === false) culprits.push(entity?.id ?? '(unknown)')
            }
            const red = culprits.length > 0
            const now = Date.now()

            if (!runtime.options.watch) {
                // One-shot build: there is no "next cycle" to debounce
                // against, so a green build syncs immediately and a red
                // one just logs and exits without touching git.
                if (red) {
                    logger.warn('git: build had failures (%s) — not syncing', culprits.join(', '))
                    return
                }
                await enqueueGit(() => runSyncPass(logger))
                return
            }

            if (red) {
                logger.warn('git: cycle had failures (%s) — holding sync this round', culprits.join(', '))
                debounceState = reduceDebounce(debounceState, { type: 'red', now }, { afterMs, maxWaitMs })
                if (timer) { clearTimeout(timer); timer = null }
                return
            }
            debounceState = reduceDebounce(debounceState, { type: 'green', now }, { afterMs, maxWaitMs })

            // A change set does not wait out the human-editing window.
            //
            // `after` exists to batch someone typing: commit once they stop,
            // not once per keystroke. An agent's request is already batched —
            // the set IS the batch — so holding it for another minute only
            // delays the moment it can be undone, and made the id it was
            // handed useless in the meantime.
            //
            // Closed means the writer said it was finished, so there is
            // nothing to wait for. Open means it might still grow, so it waits
            // out its own much shorter quiet period instead.
            // Measured from the WRITES, not from the cycle.
            //
            // A cycle runs for anything that touches the engine, including
            // work with no change set behind it. Letting that push the
            // deadline out means a server with an agent connected — issuing
            // reads, previews, renders — never goes quiet and never commits,
            // while the policy looks like it is working. The deadline belongs
            // to the change set: when IT last grew, not when anything last
            // happened.
            const readyAt = await soonestChangeSetDeadline(now)
            if (readyAt !== null) {
                debounceState = {
                    ...debounceState,
                    fireAt: debounceState.fireAt === null ? readyAt : Math.min(debounceState.fireAt, readyAt),
                }
            }
            scheduleFire(logger)
        })
    }
}
