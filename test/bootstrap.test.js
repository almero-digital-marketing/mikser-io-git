// decideBootstrap is pure — plain facts in, a decision out — so every
// folder-state combination is directly testable without touching a
// filesystem or a git binary.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { decideBootstrap } from '../lib/bootstrap.js'

const EXPECTED = 'https://github.com/org/content.git'

describe('decideBootstrap', async () => {
    it('clones into a folder that does not exist yet', async () => {
        const d = decideBootstrap({ folderExists: false, folderEmpty: true, isRepo: false, remoteUrl: null, expectedUrl: EXPECTED })
        assert.equal(d.action, 'clone')
    })

    it('clones into an existing empty folder', async () => {
        const d = decideBootstrap({ folderExists: true, folderEmpty: true, isRepo: false, remoteUrl: null, expectedUrl: EXPECTED })
        assert.equal(d.action, 'clone')
    })

    it('refuses a non-empty folder that is not a git repo — the destructive case', async () => {
        const d = decideBootstrap({ folderExists: true, folderEmpty: false, isRepo: false, remoteUrl: null, expectedUrl: EXPECTED })
        assert.equal(d.action, 'refuse')
        assert.match(d.reason, /not a git repository/i)
        assert.match(d.reason, /git init/)   // the manual recipe must be in the message
    })

    it('verifies an existing checkout whose remote matches', async () => {
        const d = decideBootstrap({ folderExists: true, folderEmpty: false, isRepo: true, remoteUrl: EXPECTED, expectedUrl: EXPECTED })
        assert.equal(d.action, 'verify')
    })

    it('verify tolerates a trailing-slash / missing .git cosmetic difference', async () => {
        const d = decideBootstrap({
            folderExists: true, folderEmpty: false, isRepo: true,
            remoteUrl: 'https://github.com/org/content',   // no .git suffix
            expectedUrl: EXPECTED,                          // has .git suffix
        })
        assert.equal(d.action, 'verify')
    })

    it('refuses an existing repo with no origin remote at all', async () => {
        const d = decideBootstrap({ folderExists: true, folderEmpty: false, isRepo: true, remoteUrl: null, expectedUrl: EXPECTED })
        assert.equal(d.action, 'refuse')
        assert.match(d.reason, /no "origin" remote/i)
    })

    it('refuses an existing repo whose remote points somewhere else', async () => {
        const d = decideBootstrap({
            folderExists: true, folderEmpty: false, isRepo: true,
            remoteUrl: 'https://github.com/someone-else/other-repo.git',
            expectedUrl: EXPECTED,
        })
        assert.equal(d.action, 'refuse')
        assert.match(d.reason, /does not match the configured repo/i)
    })
})
