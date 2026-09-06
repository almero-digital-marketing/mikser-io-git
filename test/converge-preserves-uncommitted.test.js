// A promote must not destroy work that has not been committed yet.
//
// `converge` exists so the write branch stops re-diffing against a base the
// target has moved past. It did that with `git reset --hard origin/<target>`
// — on mikser's LIVE working folder, the directory agents, WebDAV and the
// build write to continuously. `reset --hard` discards every uncommitted
// modification to a tracked file, silently.
//
// Confirmed twice on a production site. The clearest one: a change set made
// two edits to styles/hero.css seconds apart. The sync pass committed between
// them — the commit contains the FIRST edit and nothing else, which git still
// shows — and converge then reset the folder, taking the second edit with it.
// The built output kept the newer render, because out/ is gitignored and a
// reset leaves ignored files alone, so the site looked correct while the
// source had gone backwards. It surfaced 46 minutes later as a "reverted"
// file after a restart, long after the evidence pointed anywhere useful.
//
// Absent the reset the write was never in danger: commitAndPushWriteBranch
// sweeps whatever is dirty and unclaimed into a commit of its own, precisely
// so nothing is dropped. The reset ran first.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as git from '../lib/git.js'
import { converge } from '../lib/sync.js'

let origin, work
const file = (dir, name) => path.join(dir, name)

// A real remote and a real checkout: the behaviour under test is git's, and a
// stub would be asserting my model of git rather than git.
beforeEach(async () => {
    origin = await mkdtemp(path.join(tmpdir(), 'mikser-converge-origin-'))
    work = await mkdtemp(path.join(tmpdir(), 'mikser-converge-work-'))

    await git.run(origin, ['init', '-q', '--bare', '--initial-branch=production'])
    await git.run(work, ['init', '-q', '--initial-branch=production'])
    await git.run(work, ['config', 'user.email', 't@example.com'])
    await git.run(work, ['config', 'user.name', 'test'])
    await git.run(work, ['remote', 'add', 'origin', origin])

    await writeFile(file(work, 'hero.css'), 'v1\n')
    await git.addAll(work)
    await git.commit(work, 'base')
    await git.run(work, ['push', '-q', '-u', 'origin', 'production'])

    // The write branch, one commit ahead — the state right after a sync pass
    // committed and pushed.
    await git.run(work, ['checkout', '-q', '-b', 'mikser'])
    await writeFile(file(work, 'hero.css'), 'v2-committed\n')
    await git.addAll(work)
    await git.commit(work, 'the change set commit')
    await git.run(work, ['push', '-q', '-u', 'origin', 'mikser'])
})

afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
})

// The forge merged the PR: production now contains the write branch.
async function forgeMergesThePr() {
    const merger = await mkdtemp(path.join(tmpdir(), 'mikser-converge-merge-'))
    await git.run(merger, ['clone', '-q', origin, '.'])
    await git.run(merger, ['config', 'user.email', 't@example.com'])
    await git.run(merger, ['config', 'user.name', 'test'])
    await git.run(merger, ['checkout', '-q', 'production'])
    await git.run(merger, ['merge', '-q', '--no-ff', '--no-edit', 'origin/mikser'])
    await git.run(merger, ['push', '-q', 'origin', 'production'])
    await rm(merger, { recursive: true, force: true })
}

describe('converge, with an uncommitted write in the tree', () => {
    it('does not discard it', async () => {
        await forgeMergesThePr()

        // The write that lands during the PR round trip — cycle N+1, after the
        // commit, before converge. This is the byte sequence that was lost.
        await writeFile(file(work, 'hero.css'), 'v3-uncommitted\n')

        await converge(work, { writeBranch: 'mikser', targetBranch: 'production' })

        assert.equal(await readFile(file(work, 'hero.css'), 'utf8'), 'v3-uncommitted\n',
            'the uncommitted write must still be on disk after a promote')
    })

    it('leaves it dirty, so the next sweep commits it', async () => {
        // Surviving on disk is not enough — it has to still look like work
        // git has not taken yet, or the sweep walks past it and the next
        // reset does destroy it.
        await forgeMergesThePr()
        await writeFile(file(work, 'hero.css'), 'v3-uncommitted\n')
        await converge(work, { writeBranch: 'mikser', targetBranch: 'production' })

        assert.equal(await git.hasChanges(work), true,
            'the write must remain visible as uncommitted work')
    })

    it('still converges when the tree is clean', async () => {
        // The reason converge exists must survive the fix: after a promote the
        // write branch has to stop trailing the target — on the REMOTE, which
        // is what the forge and the next promote look at. Asserting only the
        // local branch let a converge that never pushed pass.
        await forgeMergesThePr()
        await converge(work, { writeBranch: 'mikser', targetBranch: 'production' })

        await git.fetch(work, {})
        assert.equal(await git.commitsAhead(work, 'origin/production', 'mikser'), 0,
            'the local write branch must have caught up with the target')
        assert.equal(await git.revParse(work, 'origin/mikser'),
                     await git.revParse(work, 'origin/production'),
            'and the remote write branch must have been pushed up to match')
    })
})

// A squash merge leaves the target with a commit that is NOT a descendant of
// the write branch, so no fast-forward exists. Aligning then genuinely means
// moving files — which is safe only when there is nothing uncommitted to move
// over. This is the path the old code took unconditionally.
describe('converge, when the target was squash-merged', () => {
    async function forgeSquashesThePr() {
        const merger = await mkdtemp(path.join(tmpdir(), 'mikser-converge-squash-'))
        await git.run(merger, ['clone', '-q', origin, '.'])
        await git.run(merger, ['config', 'user.email', 't@example.com'])
        await git.run(merger, ['config', 'user.name', 'test'])
        await git.run(merger, ['checkout', '-q', 'production'])
        await git.run(merger, ['merge', '-q', '--squash', 'origin/mikser'])
        await git.run(merger, ['commit', '-q', '-m', 'squashed'])
        await git.run(merger, ['push', '-q', 'origin', 'production'])
        await rm(merger, { recursive: true, force: true })
    }

    it('still converges when the tree is clean', async () => {
        await forgeSquashesThePr()
        const result = await converge(work, { writeBranch: 'mikser', targetBranch: 'production' })
        assert.equal(result.converged, true)
        await git.fetch(work, {})
        assert.equal(await git.commitsAhead(work, 'origin/production', 'mikser'), 0)
    })

    it('declines, rather than resetting over uncommitted work', async () => {
        await forgeSquashesThePr()
        await writeFile(file(work, 'hero.css'), 'v3-uncommitted\n')

        const warnings = []
        const result = await converge(work, {
            writeBranch: 'mikser', targetBranch: 'production',
            logger: { warn: (...args) => warnings.push(args.join(' ')) },
        })

        assert.equal(result.converged, false)
        assert.equal(result.reason, 'uncommitted-work')
        assert.equal(await readFile(file(work, 'hero.css'), 'utf8'), 'v3-uncommitted\n',
            'the write survives a promote it could not converge through')
        assert.equal(warnings.length, 1,
            'and the skip is announced — a silent one is how this went unnoticed for weeks')
    })
})
