import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRepoUrl } from '../lib/repo-url.js'

describe('parseRepoUrl', () => {
    it('parses a github.com URL and defaults apiOrigin to api.github.com', () => {
        const r = parseRepoUrl('https://github.com/almero-digital-marketing/gpoint-content.git')
        assert.deepEqual(r, { owner: 'almero-digital-marketing', repo: 'gpoint-content', apiOrigin: 'https://api.github.com' })
    })

    it('parses without the .git suffix identically', () => {
        const r = parseRepoUrl('https://github.com/org/repo')
        assert.equal(r.owner, 'org')
        assert.equal(r.repo, 'repo')
    })

    it('a self-hosted Gitea URL uses its own origin as apiOrigin (adapter appends /api/v1)', () => {
        const r = parseRepoUrl('https://git.almero.bg/org/content.git')
        assert.deepEqual(r, { owner: 'org', repo: 'content', apiOrigin: 'https://git.almero.bg' })
    })

    it('tolerates a trailing slash', () => {
        const r = parseRepoUrl('https://git.almero.bg/org/content/')
        assert.equal(r.repo, 'content')
    })

    it('throws on a URL with no owner/repo path', () => {
        assert.throws(() => parseRepoUrl('https://github.com/'), /cannot derive owner\/repo/)
    })

    it('throws on garbage input', () => {
        assert.throws(() => parseRepoUrl('not a url'), /not a valid URL/)
    })
})
