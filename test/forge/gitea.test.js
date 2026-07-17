import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ensurePR, mergePR } from '../../lib/forge/gitea.js'

function fakeResponse({ ok = true, status = 200, body = {} } = {}) {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        json: async () => body,
    }
}

const CTX = { apiBase: 'https://git.almero.bg', owner: 'org', repo: 'content', head: 'mikser', base: 'main', title: 'Promote', token: 'tok' }

describe('gitea forge adapter', () => {
    it('ensurePR reuses an existing open PR matched by head/base ref', async () => {
        const calls = []
        const fetchImpl = async (url, opts) => {
            calls.push({ url, method: opts?.method ?? 'GET' })
            return fakeResponse({
                body: [
                    { number: 3, head: { ref: 'some-other-branch' }, base: { ref: 'main' } },
                    { number: 5, head: { ref: 'mikser' }, base: { ref: 'main' }, html_url: 'https://git.almero.bg/org/content/pulls/5' },
                ],
            })
        }
        const pr = await ensurePR({ ...CTX, fetchImpl })
        assert.deepEqual(pr, { number: 5, url: 'https://git.almero.bg/org/content/pulls/5' })
        assert.equal(calls.length, 1)
        assert.match(calls[0].url, /\/api\/v1\/repos\/org\/content\/pulls\?state=open/)
    })

    it('ensurePR creates a new PR when the open list has no head/base match', async () => {
        const calls = []
        const fetchImpl = async (url, opts) => {
            calls.push({ url, method: opts?.method ?? 'GET' })
            if (!opts?.method || opts.method === 'GET') return fakeResponse({ body: [] })
            return fakeResponse({ status: 201, body: { number: 11, html_url: 'https://git.almero.bg/org/content/pulls/11' } })
        }
        const pr = await ensurePR({ ...CTX, fetchImpl })
        assert.deepEqual(pr, { number: 11, url: 'https://git.almero.bg/org/content/pulls/11' })
        assert.equal(calls[1].method, 'POST')
    })

    it('ensurePR posts the correct body shape when creating', async () => {
        let capturedBody = null
        const fetchImpl = async (url, opts) => {
            if (!opts?.method || opts.method === 'GET') return fakeResponse({ body: [] })
            capturedBody = JSON.parse(opts.body)
            return fakeResponse({ status: 201, body: { number: 1, html_url: 'x' } })
        }
        await ensurePR({ ...CTX, fetchImpl })
        assert.deepEqual(capturedBody, { title: 'Promote', head: 'mikser', base: 'main' })
    })

    it('mergePR posts { Do: "merge" } — Gitea-specific field name and casing', async () => {
        let capturedBody = null
        let capturedMethod = null
        const fetchImpl = async (url, opts) => {
            capturedMethod = opts.method
            capturedBody = JSON.parse(opts.body)
            return fakeResponse({ body: {} })
        }
        const result = await mergePR({ apiBase: 'https://git.almero.bg', owner: 'org', repo: 'content', number: 5, token: 'tok', fetchImpl })
        assert.deepEqual(result, { merged: true })
        assert.equal(capturedMethod, 'POST')   // NOT PUT — differs from the GitHub adapter
        assert.deepEqual(capturedBody, { Do: 'merge' })
    })

    it('mergePR reports merged:false with a reason on failure', async () => {
        const fetchImpl = async () => fakeResponse({ ok: false, status: 409, body: { message: 'merge conflict' } })
        const result = await mergePR({ apiBase: 'https://git.almero.bg', owner: 'org', repo: 'content', number: 5, token: 'tok', fetchImpl })
        assert.equal(result.merged, false)
        assert.match(result.reason, /merge conflict/)
    })

    it('auth header uses the Gitea "token" scheme, not Bearer', async () => {
        const seenHeaders = []
        const fetchImpl = async (url, opts) => {
            seenHeaders.push(opts.headers)
            return fakeResponse({ body: [] })   // empty list → falls through to create, also hit by this fetchImpl
        }
        await ensurePR({ ...CTX, fetchImpl })
        assert.ok(seenHeaders.length > 0)
        for (const headers of seenHeaders) {
            assert.equal(headers.Authorization, 'token tok')
        }
    })
})
