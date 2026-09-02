// A failed promote has to be retried, and "ask again" is not a conflict.
//
// Observed end to end: an edit reached the write branch, the plugin opened a
// PR, the merge came back "Please try again later" — Gitea's answer when it
// has not finished computing mergeability — and that was the end of it. The
// PR sat open and mergeable for as long as anyone cared to poll it. The site
// served the edit from the working folder while the branch that defines what
// is deployed did not carry it.
//
// Two causes, and both had to go:
//
//   1. mergePR gave one shape to "a human must resolve this" and "not ready,
//      ask again in a second".
//   2. promote ran only in the moment after a commit, so retrying required
//      another edit — and an editor who has finished editing never supplies
//      one.
//
// So the condition to act on is "the write branch is ahead of the target",
// which survives the editor going home.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { mergePR as giteaMerge, readPR as giteaRead } from '../lib/forge/gitea.js'
import { mergePR as githubMerge } from '../lib/forge/github.js'
import * as git from '../lib/git.js'
import { promoteEscalation } from '../lib/sync.js'

const res = ({ ok = true, status = 200, body = {} } = {}) => ({
    ok, status, statusText: ok ? 'OK' : 'Error', json: async () => body,
})

const CTX = { apiBase: 'https://git.test', owner: 'org', repo: 'content', number: 2, token: 'tok' }

describe('classifying a merge failure', () => {
    it('reads Gitea "Please try again later" as transient', async () => {
        // The exact string from the incident. It is a RETRY signal — the API
        // saying "ask again" — and asking again worked.
        const out = await giteaMerge({
            ...CTX,
            fetchImpl: async () => res({ ok: false, status: 405, body: { message: 'Please try again later' } }),
        })
        assert.equal(out.merged, false)
        assert.equal(out.transient, true, 'must not be treated as a conflict')
    })

    it('reads a real conflict as terminal', async () => {
        // Nobody should auto-resolve someone else's content collision, so this
        // one still stops and waits for a person.
        const out = await giteaMerge({
            ...CTX,
            fetchImpl: async () => res({ ok: false, status: 405, body: { message: 'Merge conflict detected' } }),
        })
        assert.equal(out.merged, false)
        assert.equal(out.transient, false, 'a conflict must not be retried forever')
    })

    it('reads a moved head as transient, on either forge', async () => {
        // 409: the tip changed between the check and the merge. The next poll
        // sees the new one.
        for (const merge of [giteaMerge, githubMerge]) {
            const out = await merge({
                ...CTX,
                fetchImpl: async () => res({ ok: false, status: 409, body: { message: 'head has changed' } }),
            })
            assert.equal(out.transient, true)
        }
    })

    it('treats an unrecognised failure as terminal', async () => {
        // A wrong guess this way leaves a PR for a person, which is the safe
        // error. Guessing transient for a real problem retries forever and
        // buries it.
        const out = await giteaMerge({
            ...CTX,
            fetchImpl: async () => res({ ok: false, status: 403, body: { message: 'branch is protected' } }),
        })
        assert.equal(out.transient, false)
    })
})

describe('asking the forge before attempting the merge', () => {
    it('reports mergeable: null while the forge is still computing', async () => {
        const state = await giteaRead({
            ...CTX,
            fetchImpl: async () => res({ body: { mergeable: null, merged: false } }),
        })
        assert.deepEqual(state, { mergeable: null, merged: false })
    })

    it('reports the same PR as mergeable once it settles, with no new commit', async () => {
        // The whole point: nothing about the branches changed between these
        // two answers. Only the forge caught up.
        const state = await giteaRead({
            ...CTX,
            fetchImpl: async () => res({ body: { mergeable: true, merged: false } }),
        })
        assert.deepEqual(state, { mergeable: true, merged: false })
    })

    it('reports a PR merged out of band', async () => {
        // Someone unblocking this very condition by hand. The work IS
        // promoted, and promote() converges and says so rather than
        // attempting a merge that would fail for a meaningless reason.
        const state = await giteaRead({
            ...CTX,
            fetchImpl: async () => res({ body: { mergeable: false, merged: true } }),
        })
        assert.equal(state.merged, true)
    })

    it('survives an API that will not answer', async () => {
        // A promote must not be blocked by a failed GET — it falls through to
        // attempting the merge, exactly as before this check existed.
        assert.equal(await giteaRead({ ...CTX, fetchImpl: async () => res({ ok: false, status: 500 }) }), null)
        assert.equal(await giteaRead({ ...CTX, fetchImpl: async () => { throw new Error('offline') } })
            .catch(() => 'threw'), 'threw')
    })
})

describe('is there anything outstanding to promote', () => {
    let folder

    before(async () => {
        folder = await mkdtemp(path.join(tmpdir(), 'git-ahead-'))
        const run = (...args) => git.run(folder, args)
        await run('init', '-q', '-b', 'main')
        await run('config', 'user.email', 't@test')
        await run('config', 'user.name', 'Test')
        await writeFile(path.join(folder, 'a.txt'), 'one\n')
        await run('add', '-A')
        await run('commit', '-qm', 'first')
        await run('branch', 'mikser')
    })
    after(() => rm(folder, { recursive: true, force: true }))

    it('says nothing is outstanding when the target already has it', async () => {
        assert.equal(await git.commitsAhead(folder, 'mikser', 'main'), 0)
    })

    it('counts what the write branch carries and the target does not', async () => {
        // This is the condition that replaced "we just committed" — it is
        // still true tomorrow, which is the difference.
        const run = (...args) => git.run(folder, args)
        await run('checkout', '-q', 'mikser')
        await writeFile(path.join(folder, 'b.txt'), 'two\n')
        await run('add', '-A')
        await run('commit', '-qm', 'an edit that has not been promoted')

        assert.equal(await git.commitsAhead(folder, 'mikser', 'main'), 1)
        // And not the other way around — direction matters, or a target that
        // moved ahead would read as outstanding work forever.
        assert.equal(await git.commitsAhead(folder, 'main', 'mikser'), 0)
    })

    it('goes back to nothing outstanding once the target catches up', async () => {
        const run = (...args) => git.run(folder, args)
        await run('checkout', '-q', 'main')
        await run('merge', '-q', '--no-edit', 'mikser')
        assert.equal(await git.commitsAhead(folder, 'mikser', 'main'), 0)
    })
})

describe('the race, end to end', () => {
    let origin, folder

    before(async () => {
        origin = await mkdtemp(path.join(tmpdir(), 'git-origin-'))
        await git.run(origin, ['init', '-q', '--bare', '-b', 'main'])

        folder = await mkdtemp(path.join(tmpdir(), 'git-clone-'))
        const run = (...args) => git.run(folder, args)
        await run('init', '-q', '-b', 'main')
        await run('config', 'user.email', 't@test')
        await run('config', 'user.name', 'Test')
        await run('remote', 'add', 'origin', origin)
        await writeFile(path.join(folder, 'page.md'), 'original\n')
        await run('add', '-A')
        await run('commit', '-qm', 'first')
        await run('push', '-q', 'origin', 'main')

        // The editor's change: on the write branch, pushed, not promoted.
        await run('checkout', '-q', '-b', 'mikser')
        await writeFile(path.join(folder, 'page.md'), 'edited over WebDAV\n')
        await run('add', '-A')
        await run('commit', '-qm', 'an edit from the CMS')
        await run('push', '-q', 'origin', 'mikser')
        await run('fetch', '-q', 'origin')
    })
    after(async () => {
        await rm(origin, { recursive: true, force: true })
        await rm(folder, { recursive: true, force: true })
    })

    // A forge that needs to be asked twice, which is the whole bug.
    function flakyForge() {
        const state = { reads: 0, merges: 0, mergeable: null }
        const fetchImpl = async (url, opts = {}) => {
            const method = opts.method ?? 'GET'
            if (url.endsWith('/merge') && method === 'POST') {
                state.merges++
                if (state.mergeable !== true) {
                    return res({ ok: false, status: 405, body: { message: 'Please try again later' } })
                }
                return res({ body: {} })
            }
            if (/\/pulls\?state=open$/.test(url)) {
                return res({ body: [{ number: 2, head: { ref: 'mikser' }, base: { ref: 'main' },
                    html_url: 'https://git.test/org/content/pulls/2' }] })
            }
            if (/\/pulls\/2$/.test(url)) {
                state.reads++
                // Not computed on the first ask; settled on the second. No
                // commit happens in between — that is the point.
                if (state.reads > 1) state.mergeable = true
                return res({ body: { mergeable: state.mergeable, merged: false } })
            }
            return res({ ok: false, status: 404 })
        }
        return { state, fetchImpl }
    }

    it('waits rather than giving up, then lands on the next poll with no new commit', async () => {
        const { promotePending } = await import('../lib/sync.js')
        const { state, fetchImpl } = flakyForge()
        const opts = {
            forge: 'gitea', targetBranch: 'main', writeBranch: 'mikser',
            owner: 'org', repo: 'content', apiBase: 'https://git.test',
            prTitle: 'Promote mikser → main', fetchImpl,
        }

        // First poll: the forge has not computed mergeability.
        const first = await promotePending(folder, opts)
        assert.equal(first.ahead, 1, 'the write branch is ahead, which is what makes this outstanding work')
        assert.equal(first.promoted, false)
        assert.equal(first.transient, true, 'not ready is not a conflict')
        assert.equal(state.merges, 0, 'and it does not even attempt the merge — it asks first')

        // Second poll. Nothing was committed. Nothing about the branches
        // changed. Only the forge caught up.
        const second = await promotePending(folder, opts)
        assert.equal(second.promoted, true, 'the promote must land on its own, with no further edit')
        assert.equal(second.prUrl, 'https://git.test/org/content/pulls/2', 'the same PR, not a new one')
    })

    it('reports nothing outstanding once the target carries it', async () => {
        // The old code could not tell "promoted" from "never tried" — this is
        // the check the poll uses to stay quiet.
        const run = (...args) => git.run(folder, args)
        await run('checkout', '-q', 'main')
        await run('merge', '-q', '--no-edit', 'mikser')
        await run('push', '-q', 'origin', 'main')
        await run('fetch', '-q', 'origin')

        const { promotePending } = await import('../lib/sync.js')
        const out = await promotePending(folder, {
            forge: 'gitea', targetBranch: 'main', writeBranch: 'mikser',
            owner: 'org', repo: 'content', apiBase: 'https://git.test',
            fetchImpl: async () => { throw new Error('the forge must not be called when there is nothing to do') },
        })
        assert.equal(out, null)
    })
})

describe('how loudly to say it did not promote', () => {
    const STUCK = 5 * 60 * 1000
    const esc = (o) => promoteEscalation({ stuckAfterMs: STUCK, ...o })

    it('stays quiet while a transient failure is still young', () => {
        // The poll is already retrying. Announcing it every 30 seconds is how
        // a channel gets muted, and the muted channel is where the real one
        // would have appeared.
        assert.equal(esc({ transient: true, aheadSince: Date.now() - 30_000, now: Date.now() }), 'quiet')
    })

    it('warns immediately for a failure a human has to resolve', () => {
        // A conflict does not get quieter treatment just because it is new.
        assert.equal(esc({ transient: false, aheadSince: Date.now() - 1_000, now: Date.now() }), 'warn')
    })

    it('escalates to error once the branch has been ahead too long', () => {
        const now = Date.now()
        assert.equal(esc({ transient: false, aheadSince: now - STUCK - 1, now }), 'error')
    })

    it('escalates even a transient reason that has persisted', () => {
        // This is the case from the incident. "Please try again later" is a
        // retry signal for a second, not for an hour — at some point it is
        // simply not promoting, whatever the forge calls it.
        const now = Date.now()
        assert.equal(esc({ transient: true, aheadSince: now - STUCK - 1, now }), 'error')
    })

    it('does not escalate on the very first observation', () => {
        const now = Date.now()
        assert.equal(esc({ transient: true, aheadSince: now, now }), 'quiet')
        assert.equal(esc({ transient: false, aheadSince: now, now }), 'warn')
    })
})
