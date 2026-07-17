// reduceDebounce is pure — feed a sequence of green/red events with
// explicit timestamps, assert the resulting fireAt. Covers both halves
// of the design: the short debounce after a green cycle, and the
// maxWait ceiling that keeps a steady stream of green cycles from
// starving the sync forever.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { reduceDebounce, IDLE_DEBOUNCE_STATE } from '../lib/debounce.js'

const CFG = { afterMs: 60_000, maxWaitMs: 600_000 }   // 1m / 10m, matches the plugin's defaults

describe('reduceDebounce', () => {
    it('a single green event fires after `after`', () => {
        const s = reduceDebounce(IDLE_DEBOUNCE_STATE, { type: 'green', now: 1000 }, CFG)
        assert.equal(s.pendingSince, 1000)
        assert.equal(s.fireAt, 1000 + CFG.afterMs)
    })

    it('a red event clears the window outright', () => {
        const afterGreen = reduceDebounce(IDLE_DEBOUNCE_STATE, { type: 'green', now: 1000 }, CFG)
        const afterRed = reduceDebounce(afterGreen, { type: 'red', now: 2000 }, CFG)
        assert.deepEqual(afterRed, IDLE_DEBOUNCE_STATE)
    })

    it('a later green event pushes fireAt out again (trailing debounce)', () => {
        let s = reduceDebounce(IDLE_DEBOUNCE_STATE, { type: 'green', now: 0 }, CFG)
        s = reduceDebounce(s, { type: 'green', now: 30_000 }, CFG)
        // pendingSince stays at the FIRST green (0); fireAt tracks the latest green + after,
        // capped by pendingSince + maxWait (0 + 600_000 = 600_000, not yet reached).
        assert.equal(s.pendingSince, 0)
        assert.equal(s.fireAt, 30_000 + CFG.afterMs)
    })

    it('a steady stream of green events is bounded by maxWait — never starves forever', () => {
        let s = reduceDebounce(IDLE_DEBOUNCE_STATE, { type: 'green', now: 0 }, CFG)
        // Green every 30s, well under the 60s `after` window, for 20 minutes —
        // a pure trailing debounce would never fire.
        for (let now = 30_000; now <= 1_200_000; now += 30_000) {
            s = reduceDebounce(s, { type: 'green', now }, CFG)
        }
        // fireAt must never exceed pendingSince + maxWait (0 + 600_000).
        assert.ok(s.fireAt <= CFG.maxWaitMs, `fireAt ${s.fireAt} exceeded the maxWait ceiling ${CFG.maxWaitMs}`)
        assert.equal(s.fireAt, CFG.maxWaitMs)
    })

    it('a red event after being interrupted then going green again starts a FRESH window', () => {
        let s = reduceDebounce(IDLE_DEBOUNCE_STATE, { type: 'green', now: 0 }, CFG)
        s = reduceDebounce(s, { type: 'red', now: 100_000 }, CFG)
        s = reduceDebounce(s, { type: 'green', now: 200_000 }, CFG)
        // pendingSince resets to the new green's timestamp, not the original 0 —
        // otherwise the maxWait ceiling would already be looming from unrelated history.
        assert.equal(s.pendingSince, 200_000)
        assert.equal(s.fireAt, 200_000 + CFG.afterMs)
    })
})
