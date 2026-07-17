// mikser-io-git — two-way git sync for mikser-io.
//
// Model: the working folder is a checkout on a dedicated write branch
// (default `mikser`) that this plugin owns exclusively. Every green
// cycle (no render/postprocess failure) commits + pushes whatever's on
// disk to that branch — unconditionally, so an agent's work is never
// lost to a crash or a later red cycle — then tries to promote it into
// the target branch (default `main`) via a pull request (GitHub/Gitea)
// or a direct fast-forward push (`forge: 'none'`, any bare remote). A
// red cycle holds the promotion but the write-branch commit still
// happens on the next green cycle once the queued changes accumulate
// on disk — nothing here tracks a pending set separately from the
// filesystem itself. A promotion conflict just leaves the PR open;
// this plugin never resolves a conflict or picks a winner.
//
// Inbound: remote changes on either branch are pulled in on a poll
// timer (webhook delivery is NOT implemented — see README) and merged
// into the local write branch; a merge conflict aborts immediately so
// the working folder — mikser's live render source — never holds
// conflict-marker text as page content.
//
// First-connect safety: if the configured folder already has files but
// isn't a git checkout, the plugin refuses to guess whether local or
// remote content should win (either default silently discards the
// other side on the very next sync) and logs the one-time manual
// recipe to attach history without touching a single file.

import path from 'node:path'
import { resolveConfig } from './lib/config.js'
import { gatherFolderState, decideBootstrap, performClone, performVerify } from './lib/bootstrap.js'
import { commitAndPushWriteBranch, promote } from './lib/sync.js'
import { pullInbound } from './lib/inbound.js'
import { reduceDebounce, IDLE_DEBOUNCE_STATE } from './lib/debounce.js'

const REANNOUNCE_MS = 30 * 60 * 1000   // re-log a still-open conflict at most every 30 min

export function git(options = {}) {
    const {
        url, folder: folderOption, forge, targetBranch, writeBranch,
        token, message, author, afterMs, maxWaitMs, pollIntervalMs,
        owner, repo, apiBase,
    } = resolveConfig(options)

    return ({ runtime, onLoaded, onFinalize, useLogger, useJournal, constants: { OPERATION } }) => {
        const folder = path.isAbsolute(folderOption)
            ? folderOption
            : path.join(runtime.options.workingFolder, folderOption)

        let debounceState = IDLE_DEBOUNCE_STATE
        let timer = null
        let pollTimer = null
        let lastPromoteFailureReason = null
        let lastPromoteFailureLoggedAt = 0
        let inert = false   // set true on a bootstrap refusal; the plugin stops touching the folder for the rest of this process

        async function runSyncPass(logger) {
            debounceState = IDLE_DEBOUNCE_STATE
            try {
                const { committed } = await commitAndPushWriteBranch(folder, { writeBranch, message, author, token })
                if (!committed) return
                logger.info('git: committed + pushed to %s', writeBranch)

                const result = await promote(folder, {
                    forge, targetBranch, writeBranch, token, owner, repo, apiBase,
                    prTitle: `Promote ${writeBranch} → ${targetBranch}`,
                })
                if (result.promoted) {
                    logger.info('git: promoted %s → %s', writeBranch, targetBranch)
                    lastPromoteFailureReason = null
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
            } catch (err) {
                logger.error('git: sync pass failed — %s', err.stderr || err.message)
            }
        }

        function scheduleFire(logger) {
            if (timer) clearTimeout(timer)
            const delay = Math.max(0, debounceState.fireAt - Date.now())
            timer = setTimeout(() => runSyncPass(logger), delay)
            timer.unref?.()
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
            logger.info('git: working folder ready — %s on branch %s (promotes to %s via %s)', folder, writeBranch, targetBranch, forge)

            // Inbound polling — watch mode only; a one-shot build has no
            // "later" to pull into. Webhook delivery is not implemented
            // (see README); poll is the only supported inbound trigger.
            if (runtime.options.watch && pollIntervalMs > 0) {
                pollTimer = setInterval(async () => {
                    if (inert) return
                    await pullInbound(folder, { writeBranch, targetBranch, token, logger })
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
                await runSyncPass(logger)
                return
            }

            if (red) {
                logger.warn('git: cycle had failures (%s) — holding sync this round', culprits.join(', '))
                debounceState = reduceDebounce(debounceState, { type: 'red', now }, { afterMs, maxWaitMs })
                if (timer) { clearTimeout(timer); timer = null }
                return
            }
            debounceState = reduceDebounce(debounceState, { type: 'green', now }, { afterMs, maxWaitMs })
            scheduleFire(logger)
        })
    }
}
