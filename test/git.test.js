// isNonFastForwardError is pure string-matching, tested directly.
// Everything else in lib/git.js is a thin execFile wrapper — real
// confidence there comes from exercising it against an actual git
// repo in a temp directory. This only covers the LOCAL-only
// operations (init, add, commit, status, branch) — clone/fetch/push
// need a real remote and are exercised by hand against a real forge,
// not in this suite.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as git from '../lib/git.js'

describe('isNonFastForwardError', () => {
    it('recognizes the common rejection messages', () => {
        assert.ok(git.isNonFastForwardError({ stderr: '! [rejected] main -> main (non-fast-forward)' }))
        assert.ok(git.isNonFastForwardError({ message: 'failed to push some refs (fetch first)' }))
        assert.ok(git.isNonFastForwardError({ stderr: 'Updates were rejected because the tip of your current branch is behind' }))
    })

    it('does not misclassify an unrelated error', () => {
        assert.equal(git.isNonFastForwardError({ message: 'fatal: repository not found' }), false)
    })

    it('handles a bare/malformed error object without throwing', () => {
        assert.equal(git.isNonFastForwardError({}), false)
        assert.equal(git.isNonFastForwardError(null), false)
    })
})

describe('git.js against a real local repo', () => {
    let dir

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'mikser-git-'))
        await git.run(dir, ['init', '-b', 'main'])
        // Local-only identity so commit() works in a sandboxed CI
        // environment with no global git user configured.
        await git.run(dir, ['config', 'user.email', 'test@example.com'])
        await git.run(dir, ['config', 'user.name', 'Test'])
    })

    after(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('an empty repo has no changes', async () => {
        assert.equal(await git.hasChanges(dir), false)
    })

    it('a new file registers as a change', async () => {
        await writeFile(path.join(dir, 'a.md'), 'hello')
        assert.equal(await git.hasChanges(dir), true)
        const status = await git.statusPorcelain(dir)
        assert.match(status, /a\.md/)
    })

    it('addAll stages it, then commit records it', async () => {
        await git.addAll(dir)
        assert.equal(await git.hasStagedChanges(dir), true)
        await git.commit(dir, 'first commit')
        assert.equal(await git.hasChanges(dir), false)
        assert.equal(await git.hasStagedChanges(dir), false)
    })

    it('currentBranch reports the init branch', async () => {
        assert.equal(await git.currentBranch(dir), 'main')
    })

    it('checkoutBranch creates and switches to a new branch', async () => {
        await git.checkoutBranch(dir, 'mikser', { create: true })
        assert.equal(await git.currentBranch(dir), 'mikser')
        assert.equal(await git.branchExistsLocal(dir, 'mikser'), true)
        assert.equal(await git.branchExistsLocal(dir, 'nonexistent'), false)
    })

    it('a second file + commit round-trips through the same flow on the new branch', async () => {
        await writeFile(path.join(dir, 'b.md'), 'world')
        await git.addAll(dir)
        await git.commit(dir, 'second commit')
        assert.equal(await git.hasChanges(dir), false)
        assert.equal(await git.revParse(dir, 'HEAD') !== '', true)
    })

    it('resetHard moves the branch tip and the working tree together', async () => {
        const beforeReset = await git.revParse(dir, 'HEAD')
        await writeFile(path.join(dir, 'c.md'), 'discard me')
        await git.addAll(dir)
        await git.commit(dir, 'to be discarded')
        assert.notEqual(await git.revParse(dir, 'HEAD'), beforeReset)
        await git.resetHard(dir, beforeReset)
        assert.equal(await git.revParse(dir, 'HEAD'), beforeReset)
    })
})
