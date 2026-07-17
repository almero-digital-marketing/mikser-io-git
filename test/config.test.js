import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../lib/config.js'

describe('resolveConfig', () => {
    it('requires url', () => {
        assert.throws(() => resolveConfig({}), /`url` is required/)
    })

    it('rejects an unknown forge', () => {
        assert.throws(
            () => resolveConfig({ url: 'https://github.com/org/repo.git', forge: 'bitbucket' }),
            /must be "github", "gitea", or "none"/,
        )
    })

    it('applies sane defaults for a minimal forge:none config', () => {
        const cfg = resolveConfig({ url: 'https://example.com/org/repo.git' })
        assert.equal(cfg.forge, 'none')
        assert.equal(cfg.folder, 'documents')
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

    it('derives owner/repo/apiBase from the url when forge is github', () => {
        const cfg = resolveConfig({ url: 'https://github.com/almero-digital-marketing/gpoint-content.git', forge: 'github', token: 'x' })
        assert.equal(cfg.owner, 'almero-digital-marketing')
        assert.equal(cfg.repo, 'gpoint-content')
        assert.equal(cfg.apiBase, 'https://api.github.com')
    })

    it('derives owner/repo/apiBase from the url when forge is gitea', () => {
        const cfg = resolveConfig({ url: 'https://git.almero.bg/org/content.git', forge: 'gitea', token: 'x' })
        assert.equal(cfg.owner, 'org')
        assert.equal(cfg.repo, 'content')
        assert.equal(cfg.apiBase, 'https://git.almero.bg')
    })

    it('explicit owner/repo/apiBase override the url-derived values', () => {
        const cfg = resolveConfig({
            url: 'https://github.com/org/repo.git', forge: 'github', token: 'x',
            owner: 'other-org', repo: 'other-repo', apiBase: 'https://ghe.example.com/api/v3',
        })
        assert.equal(cfg.owner, 'other-org')
        assert.equal(cfg.repo, 'other-repo')
        assert.equal(cfg.apiBase, 'https://ghe.example.com/api/v3')
    })

    it('respects custom branch names, folder, and durations', () => {
        const cfg = resolveConfig({
            url: 'https://example.com/org/repo.git',
            branch: 'live', writeBranch: 'agents', folder: 'content',
            after: '30s', maxWait: '5m', pollInterval: '1m',
        })
        assert.equal(cfg.targetBranch, 'live')
        assert.equal(cfg.writeBranch, 'agents')
        assert.equal(cfg.folder, 'content')
        assert.equal(cfg.afterMs, 30_000)
        assert.equal(cfg.maxWaitMs, 300_000)
        assert.equal(cfg.pollIntervalMs, 60_000)
    })

    it('the default message builder includes the file count', () => {
        const cfg = resolveConfig({ url: 'https://example.com/org/repo.git' })
        assert.equal(cfg.message({ fileCount: 3 }), 'content: 3 file(s) via mikser')
    })
})
