import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../lib/config.js'

describe('resolveConfig', async () => {
    it('requires url', async () => {
        assert.throws(() => resolveConfig({}), /`url` is required/)
    })

    it('rejects an unknown forge', async () => {
        assert.throws(
            () => resolveConfig({ url: 'https://github.com/org/repo.git', forge: 'bitbucket' }),
            /must be "github", "gitea", or "none"/,
        )
    })

    it('rejects an empty paths array', async () => {
        assert.throws(
            () => resolveConfig({ url: 'https://example.com/org/repo.git', paths: [] }),
            /`paths` must be a non-empty/,
        )
    })

    it('normalizes a single path string to a one-element array', async () => {
        const cfg = resolveConfig({ url: 'https://example.com/org/repo.git', paths: 'layouts' })
        assert.deepEqual(cfg.paths, ['layouts'])
    })

    it('accepts an array of paths for multiple collections sharing one checkout', async () => {
        const cfg = resolveConfig({ url: 'https://example.com/org/repo.git', paths: ['documents', 'layouts', 'files'] })
        assert.deepEqual(cfg.paths, ['documents', 'layouts', 'files'])
    })

    it('omitting paths means "no scope" — the whole working folder, not a narrower default', async () => {
        // Deliberately distinct from '[\'documents\']': the zero-config
        // case should match the model's own framing ("the working
        // folder is the checkout"), not silently narrow to one
        // collection nobody asked for.
        const cfg = resolveConfig({ url: 'https://example.com/org/repo.git' })
        assert.equal(cfg.paths, null)
    })

    it('applies sane defaults for a minimal forge:none config', async () => {
        const cfg = resolveConfig({ url: 'https://example.com/org/repo.git' })
        assert.equal(cfg.forge, 'none')
        assert.equal(cfg.paths, null)
        assert.equal(cfg.targetBranch, 'main')
        assert.equal(cfg.writeBranch, 'mikser')
        assert.equal(cfg.afterMs, 60_000)
        assert.equal(cfg.maxWaitMs, 600_000)
        assert.equal(cfg.pollIntervalMs, 300_000)
        // forge:none never needs owner/repo/apiBase — no API involved.
        assert.equal(cfg.owner, undefined)
        assert.equal(cfg.repo, undefined)
        assert.equal(cfg.apiBase, undefined)
    })

    it('derives owner/repo/apiBase from the url when forge is github', async () => {
        const cfg = resolveConfig({ url: 'https://github.com/almero-digital-marketing/gpoint-content.git', forge: 'github', token: 'x' })
        assert.equal(cfg.owner, 'almero-digital-marketing')
        assert.equal(cfg.repo, 'gpoint-content')
        assert.equal(cfg.apiBase, 'https://api.github.com')
    })

    it('derives owner/repo/apiBase from the url when forge is gitea', async () => {
        const cfg = resolveConfig({ url: 'https://git.almero.bg/org/content.git', forge: 'gitea', token: 'x' })
        assert.equal(cfg.owner, 'org')
        assert.equal(cfg.repo, 'content')
        assert.equal(cfg.apiBase, 'https://git.almero.bg')
    })

    it('explicit owner/repo/apiBase override the url-derived values', async () => {
        const cfg = resolveConfig({
            url: 'https://github.com/org/repo.git', forge: 'github', token: 'x',
            owner: 'other-org', repo: 'other-repo', apiBase: 'https://ghe.example.com/api/v3',
        })
        assert.equal(cfg.owner, 'other-org')
        assert.equal(cfg.repo, 'other-repo')
        assert.equal(cfg.apiBase, 'https://ghe.example.com/api/v3')
    })

    it('respects custom branch names, paths, and durations', async () => {
        const cfg = resolveConfig({
            url: 'https://example.com/org/repo.git',
            branch: 'live', writeBranch: 'agents', paths: ['content'],
            after: '30s', maxWait: '5m', pollInterval: '1m',
        })
        assert.equal(cfg.targetBranch, 'live')
        assert.equal(cfg.writeBranch, 'agents')
        assert.deepEqual(cfg.paths, ['content'])
        assert.equal(cfg.afterMs, 30_000)
        assert.equal(cfg.maxWaitMs, 300_000)
        assert.equal(cfg.pollIntervalMs, 60_000)
    })

    it('the default message builder includes the file count', async () => {
        const cfg = resolveConfig({ url: 'https://example.com/org/repo.git' })
        assert.equal(cfg.message({ fileCount: 3 }), 'content: 3 file(s) via mikser')
    })
})
