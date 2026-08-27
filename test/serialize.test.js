// Two timers, one checkout.
//
// The sync pass (debounced seconds after a green cycle) and the inbound
// poll (every few minutes) both run git against the same working folder,
// and nothing stopped them overlapping. git serialises through index.lock,
// so the loser fails with "Another git process seems to be running" — which
// surfaces as an intermittent sync failure that retries and looks like
// nothing. The worse shape is a commit landing while an inbound merge is in
// progress, which commits the merge rather than the intended change.
//
// The queue is the fix, and these pin its two load-bearing properties:
// operations do not interleave, and a failing one does not stall or break
// the chain behind it.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createGitQueue } from '../lib/queue.js'

const tick = (ms) => new Promise(r => setTimeout(r, ms))

describe('createGitQueue', () => {
    it('never runs two operations at once', async () => {
        const enqueue = createGitQueue()
        let active = 0
        let overlapped = false
        const op = async (ms) => {
            active++
            if (active > 1) overlapped = true
            await tick(ms)
            active--
        }
        // Deliberately started out of order and with the first one slowest,
        // which is what an overlap would need.
        await Promise.all([enqueue(() => op(30)), enqueue(() => op(5)), enqueue(() => op(5))])
        assert.equal(overlapped, false)
    })

    it('runs them in the order they were enqueued', async () => {
        const enqueue = createGitQueue()
        const order = []
        await Promise.all([
            enqueue(async () => { await tick(20); order.push('first') }),
            enqueue(async () => { order.push('second') }),
            enqueue(async () => { order.push('third') }),
        ])
        assert.deepEqual(order, ['first', 'second', 'third'])
    })

    it('keeps running after one operation fails', async () => {
        // A failed fetch must not stall every later sync pass for the life
        // of the process.
        const enqueue = createGitQueue()
        const done = []
        const failing = enqueue(async () => { throw new Error('fetch failed') })
        await assert.rejects(() => failing, /fetch failed/, 'the failure still reaches its own caller')
        await enqueue(async () => { done.push('after') })
        assert.deepEqual(done, ['after'])
    })

    it('does not leave the chain carrying an unhandled rejection', async () => {
        // The chain swallows internally so a rejected operation cannot end
        // the process through the tail; the caller's own guard reports it.
        const enqueue = createGitQueue()
        enqueue(async () => { throw new Error('ignored by design') }).catch(() => {})
        await tick(10)
        let ran = false
        await enqueue(async () => { ran = true })
        assert.ok(ran)
    })
})
