import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseDuration } from '../lib/duration.js'

describe('parseDuration', async () => {
    it('passes a plain number through unchanged', async () => {
        assert.equal(parseDuration(5000), 5000)
    })

    it('returns the fallback for null/undefined', async () => {
        assert.equal(parseDuration(undefined, 42), 42)
        assert.equal(parseDuration(null, 42), 42)
    })

    it('parses each unit', async () => {
        assert.equal(parseDuration('500ms'), 500)
        assert.equal(parseDuration('30s'), 30_000)
        assert.equal(parseDuration('1m'), 60_000)
        assert.equal(parseDuration('10m'), 600_000)
        assert.equal(parseDuration('2h'), 7_200_000)
        assert.equal(parseDuration('1d'), 86_400_000)
    })

    it('is case-insensitive on the unit', async () => {
        assert.equal(parseDuration('1M'), 60_000)
    })

    it('throws on an unparseable string', async () => {
        assert.throws(() => parseDuration('soon'), /invalid duration/i)
    })
})
