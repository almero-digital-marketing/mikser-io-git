import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ensurePR, mergePR } from '../../lib/forge/github.js'

function fakeResponse({ ok = true, status = 200, body = {} } = {}) {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        json: async () => body,
    }
}

const CTX = { owner: 'org', repo: 'content', head: 'mikser', base: 'main', title: 'Promote', token: 'tok' }

describe('github forge adapter', () => {
    it('ensurePR reuses an existing open PR instead of creating a new one', async () => {
        const calls = []
        const fetchImpl = async (url, opts) => {
            calls.push({ url, method: opts?.method ?? 'GET' })
            return fakeResponse({ body: [{ number: 7, html_url: 'https://github.com/org/content/pull/7' }] })
        }
        const pr = await ensurePR({ ...CTX, fetchImpl })
        assert.deepEqual(pr, { number: 7, url: 'https://github.com/org/content/pull/7' })
        assert.equal(calls.length, 1, 'must not call the create endpoint when one already exists')
        assert.match(calls[0].url, /head=org:mikser&base=main&state=open/)
    })

    it('ensurePR creates a new PR when none is open', async () => {
        const calls = []
        const fetchImpl = async (url, opts) => {
            calls.push({ url, method: opts?.method ?? 'GET' })
            if (!opts?.method || opts.method === 'GET') return fakeResponse({ body: [] })
            return fakeResponse({ status: 201, body: { number: 9, html_url: 'https://github.com/org/content/pull/9' } })
        }
        const pr = await ensurePR({ ...CTX, fetchImpl })
        assert.deepEqual(pr, { number: 9, url: 'https://github.com/org/content/pull/9' })
        assert.equal(calls.length, 2)
        assert.equal(calls[1].method, 'POST')
    })

    it('ensurePR throws with a readable message when creation fails', async () => {
        const fetchImpl = async (url, opts) => {
            if (!opts?.method) return fakeResponse({ body: [] })
            return fakeResponse({ ok: false, status: 422, body: { message: 'Validation failed' } })
        }
        await assert.rejects(ensurePR({ ...CTX, fetchImpl }), /Validation failed/)
    })

    it('mergePR reports merged:true on success', async () => {
        const fetchImpl = async () => fakeResponse({ body: { merged: true, sha: 'abc' } })
        const result = await mergePR({ owner: 'org', repo: 'content', number: 7, token: 'tok', fetchImpl })
        assert.deepEqual(result, { merged: true })
    })

    it('mergePR reports merged:false with a reason on conflict', async () => {
        const fetchImpl = async () => fakeResponse({ ok: false, status: 405, body: { message: 'Pull Request is not mergeable' } })
        const result = await mergePR({ owner: 'org', repo: 'content', number: 7, token: 'tok', fetchImpl })
        assert.equal(result.merged, false)
        assert.match(result.reason, /not mergeable/)
    })

    it('mergePR falls back to statusText when the error body is not JSON', async () => {
        const fetchImpl = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => { throw new Error('not json') } })
        const result = await mergePR({ owner: 'org', repo: 'content', number: 7, token: 'tok', fetchImpl })
        assert.equal(result.merged, false)
        assert.equal(result.reason, 'Internal Server Error')
    })
})
