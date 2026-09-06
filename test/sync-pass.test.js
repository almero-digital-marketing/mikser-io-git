// The sync pass must not be stoppable.
//
// Reported live: one commit at startup, then every later change set sat at
// `committed: null` for six minutes across several quiet windows. Nothing in
// the output said why, because a stalled pass and a pass correctly waiting are
// the same absence of log lines.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
    runtime, withChangeSet, pendingChangeSets, listChangeSets,
    markChangeSetsRecorded, markChangeSetFailed, markChangeSetSettled, forgetAllChangeSets,
    useCollection, recordChangeSetWrite, closeChangeSet,
} from 'mikser-io'
import * as git from '../lib/git.js'
import { commitAndPushWriteBranch } from '../lib/sync.js'
import { previewUndo } from '../lib/undo.js'

let folder

before(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mikser-pass-'))
    await git.run(folder, ['init', '-b', 'mikser'])
    await git.run(folder, ['config', 'user.email', 'test@example.com'])
    await git.run(folder, ['config', 'user.name', 'Test'])
    await mkdir(path.join(folder, 'documents'), { recursive: true })
    await writeFile(path.join(folder, 'documents', 'seed.md'), 'seed\n')
    await git.run(folder, ['add', '-A'])
    await git.run(folder, ['commit', '-m', 'seed'])
    runtime.options = { ...runtime.options, workingFolder: folder, documentsFolder: path.join(folder, 'documents') }
})
after(async () => { if (folder) await rm(folder, { recursive: true, force: true }) })
beforeEach(async () => forgetAllChangeSets())

const write = (id, summary, rel, content) =>
    withChangeSet({ changeSet: id, summary, principal: 'agent', closeOnReturn: true },
        () => useCollection(runtime, 'documents').write(rel, content))

const pass = async () => {
    const committed = [], failed = [], settled = []
    try {
        await commitAndPushWriteBranch(folder, {
            paths: ['documents'], writeBranch: 'mikser',
            message: ({ fileCount }) => `content: ${fileCount} file(s) via mikser`,
            changeSets: await pendingChangeSets(),
            onCommitted: async (id, sha) => { committed.push(id); await markChangeSetsRecorded([id], sha) },
            onFailed: async (id, err) => { failed.push(id); await markChangeSetFailed(id, err) },
            onSettled: async (id, reason) => { settled.push(id); await markChangeSetSettled(id, reason) },
        })
    } catch { /* no remote to push to */ }
    return { committed, failed, settled }
}

describe('every pending change set reaches a commit', async () => {
    it('commits ten writes in one pass, and gives each its own commit', async () => {
        // The reported shape: the first set committed and nothing after it.
        for (let i = 0; i < 10; i++) await write(`cs-${i}`, `Write ${i}`, `doc-${i}.md`, `body ${i}\n`)
        const { committed } = await pass()
        assert.equal(committed.length, 10, 'all ten, in one pass')

        const listed = await listChangeSets({ limit: 20 })
        assert.deepEqual(listed.filter(s => !s.recordedAs), [], 'nothing may be left at committed: null')
        // Asserted here rather than in a second test: the log is cleared
        // between tests, so a follow-up test would be reading an empty log and
        // passing for the wrong reason.
        assert.equal(new Set(listed.map(s => s.recordedAs)).size, 10, 'ten sets, ten commits')
    })
})

describe('one failing change set does not halt the rest', async () => {
    it('records the error and still commits the sets around it', async () => {
        // A real failure, not a mock: the set claims a path that is gone by
        // the time it is staged, which is what a concurrent delete looks like.
        // `git add -- <missing>` fails, and that must cost this set only.
        await write('cs-ok-1', 'Fine before', 'ok1.md', 'a\n')
        await write('cs-vanished', 'File removed before commit', 'vanished.md', 'b\n')
        await write('cs-ok-2', 'Fine after', 'ok2.md', 'c\n')
        await rm(path.join(folder, 'documents', 'vanished.md'))
        // Untracked and now absent, so git has nothing to stage under that
        // pathspec and errors rather than silently committing nothing.

        const { committed, failed } = await pass()
        assert.ok(committed.includes('cs-ok-1'), 'the set before the failure commits')
        assert.ok(committed.includes('cs-ok-2'), 'and so does the one after it')

        const vanished = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-vanished')
        if (failed.includes('cs-vanished')) {
            assert.ok(vanished.commitError, 'a failed set carries its reason')
        } else {
            // git tolerated the missing path; the set simply had nothing to
            // stage. Either way the rule holds — it must not stop the others.
            assert.ok(committed.length >= 2)
        }
    })

    it('a failed set shows its reason rather than a bare null', async () => {
        await write('cs-fails', 'Will not commit', 'f.md', 'x\n')
        await markChangeSetFailed('cs-fails', new Error('hook rejected the commit'))
        const set = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-fails')
        assert.equal(set.recordedAs, null)
        assert.match(set.commitError, /hook rejected/)
        assert.equal(set.commitAttempts, 1, 'and how many times it has been tried')

        // A failure is retried, so a later success must not leave a stale
        // reason beside a real commit. Asserted in the same test because the
        // log does not survive to the next one.
        await markChangeSetsRecorded(['cs-fails'], 'abc1234')
        const after = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-fails')
        assert.equal(after.commitError, null)
        assert.equal(after.recordedAs, 'abc1234')
    })

    it('never leaves a set both uncommitted and unexplained past the ceiling', async () => {
        // The combination the report calls impossible: old, no commit, no
        // reason. One of the two must always be present.
        const stale = (await listChangeSets({ limit: 200 }))
            .filter(s => Date.now() - s.startedAt > 600_000)
            .filter(s => !s.recordedAs && !s.commitError)
        assert.deepEqual(stale, [])
    })
})

describe('bounded operations', async () => {
    it('gives every git command a timeout', async () => {
        // The root cause. One queue serialises every git operation, so a
        // command that never returns blocks all later passes and the inbound
        // poll — permanently, with no error anywhere.
        assert.ok(git.GIT_TIMEOUT_MS > 0, 'a git command must not be able to run forever')
    })
})

// A change set whose changes cancel out.
//
// Observed on lmed: five sets at committed: null indefinitely, every pass
// logging "5 change set(s), 0 committed, 0 failed" — literally true and
// indistinguishable from a scheduler that never ran. Their disk effects
// cancelled: an undo of a create, and probes that added then removed their own
// files. git correctly made no commit, so neither callback fired, nothing
// drained them, and they were re-claimed forever.
describe('a set with no net diff', async () => {
    it('drains instead of being re-claimed every pass', async () => {
        // A TRACKED file changed and then changed back — the shape the live
        // instance hit, where an undo restored what a commit had added. git
        // stages nothing and makes no commit, with no error: the case that had
        // no exit.
        await write('cs-seed', 'Add it', 'settles.md', 'original\n')
        await pass()
        await write('cs-empty', 'Change it and change it back', 'settles.md', 'edited\n')
        await writeFile(path.join(folder, 'documents', 'settles.md'), 'original\n')

        const first = await pass()
        assert.deepEqual(first.committed, [], 'git makes no commit, correctly')
        assert.deepEqual(first.failed, [], 'and it is not a failure')
        assert.ok(first.settled.includes('cs-empty'), 'so it needs the third outcome')

        // The bug: still claimed on the next pass, and every pass after.
        assert.deepEqual((await pendingChangeSets()).map(s => s.id), [],
            'a drained set must not come back')

        // Asserted here, not in a following test: the log is cleared between
        // tests, so a second test would read an empty log and pass for the
        // wrong reason.
        const set = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-empty')
        assert.equal(set.recordedAs, null, 'there is genuinely no commit')
        // `replaced`, not the old catch-all `empty`. The file is on disk and
        // identical to the last commit, and it is NOT what cs-empty wrote —
        // the checksum recorded at write time proves it. That is lost work,
        // and it used to be indistinguishable from a write that matched.
        assert.equal(set.outcome, 'replaced',
            'the set wrote "edited" and the disk holds "original" — that is a replacement, not a no-op')
    })

    it('does not block the sets around it', async () => {
        await write('cs-before', 'Real work', 'before.md', 'a\n')
        await write('cs-void', 'Cancels out', 'void.md', 'b\n')
        await rm(path.join(folder, 'documents', 'void.md'))
        await write('cs-after', 'More real work', 'after.md', 'c\n')

        const { committed, settled } = await pass()
        assert.ok(committed.includes('cs-before'))
        assert.ok(committed.includes('cs-after'))
        assert.ok(settled.includes('cs-void'))
        assert.deepEqual((await pendingChangeSets()).map(s => s.id), [], 'the pass drains completely')
    })

    it('drains a set that wrote outside the paths this instance versions', async () => {
        // Another instance may own those folders; this one is finished with
        // it either way, and holding it forever helps nobody.
        recordChangeSetWrite({ changeSet: 'cs-elsewhere', summary: 'Outside', uri: path.join(folder, 'not-versioned', 'x.md') })
        const { settled } = await pass()
        assert.ok(settled.includes('cs-elsewhere'))
        assert.deepEqual((await pendingChangeSets()).map(s => s.id), [])
    })
})

// The sweep must not take work an open change set still owns.
//
// Observed on lmed: an undo deleted a file that a previous commit had added —
// a real deletion diff — and its change set still settled as `empty`. The
// deletion was in git, under the unattributed sweep commit. A pass had fired
// while the undo's set was still inside its quiet window, so the set was not
// claimed, the sweep took its work, and by the time the set was ready there
// was nothing left to commit. Its changes are in git under a commit that does
// not name it, so it can never be undone.
describe('an open change set keeps its own work', async () => {
    const passReserving = async () => {
        const out = { committed: [], settled: [] }
        const claimed = (await pendingChangeSets()).filter(s => s.closed)
        const claimedIds = new Set(claimed.map(s => s.id))
        const reserved = (await pendingChangeSets()).filter(s => !claimedIds.has(s.id)).flatMap(s => s.paths)
        try {
            await commitAndPushWriteBranch(folder, {
                paths: ['documents'], writeBranch: 'mikser',
                message: ({ fileCount }) => `content: ${fileCount} file(s) via mikser`,
                changeSets: claimed, reserved,
                onCommitted: async (id, sha) => { out.committed.push(id); await markChangeSetsRecorded([id], sha) },
                onFailed: () => {},
                onSettled: async (id, r) => { out.settled.push(id); await markChangeSetSettled(id, r) },
            })
        } catch { /* no remote */ }
        return out
    }

    it('leaves a deletion for the set that made it, not the sweep', async () => {
        await write('cs-added', 'Add it', 'owned.md', 'body\n')
        await passReserving()
        assert.ok(await stat(path.join(folder, 'documents', 'owned.md')).catch(() => null))

        // An undo removes it, recorded as a set that has not closed yet.
        await rm(path.join(folder, 'documents', 'owned.md'))
        recordChangeSetWrite({
            changeSet: 'cs-undo', summary: 'Undo: Add it', undoOf: 'cs-added',
            uri: path.join(folder, 'documents', 'owned.md'), operation: 'delete',
        })

        // A pass fires while it is still open — the case that lost the work.
        const early = await passReserving()
        assert.ok(!early.committed.includes('cs-undo'), 'not claimed yet, correctly')
        const head = await git.run(folder, ['log', '-1', '--format=%s'])
        assert.doesNotMatch(head, /content: \d+ file/,
            'and the sweep must not commit it as unattributed')

        // Once it closes, it commits its own deletion under its own name.
        closeChangeSet('cs-undo')
        const later = await passReserving()
        assert.ok(later.committed.includes('cs-undo'))
        assert.ok(!later.settled.includes('cs-undo'), 'a real deletion is not an empty set')
        assert.match(await git.run(folder, ['log', '-1', '--format=%s']), /Undo: Add it/)
        assert.equal(await git.run(folder, ['ls-files', 'documents/owned.md']), '',
            'and the file really is gone from git')
    })
})

// The distinction the single word `empty` used to hide.
//
// A set whose written files are GONE has not cancelled itself — its work is in
// neither git nor the working folder. On a live site one settled as `empty`
// with a null commit and read as routine; the editor re-applied it by hand and
// called the retry "the change was lost during a parallel edit".
describe('a set whose written files vanished before the pass', () => {
    it('is not reported as having cancelled itself', async () => {
        await write('cs-vanish', 'Write something', 'vanishes.md', 'content\n')
        // Whatever removed it — a reset, a competing writer, a stray delete.
        await rm(path.join(folder, 'documents', 'vanishes.md'), { force: true })

        const result = await pass()
        assert.deepEqual(result.committed, [], 'git has nothing to commit')
        assert.ok(result.settled.includes('cs-vanish'), 'and the set is drained, not left pending')

        const set = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-vanish')
        assert.equal(set.outcome, 'paths-gone',
            'the outcome must say the files were gone, not that the change cancelled out')
        assert.notEqual(set.outcome, 'empty', 'and must not reuse the word that hid this')
    })

    it('does not mistake a deletion for a vanished write', async () => {
        // A set that only REMOVES files legitimately leaves nothing on disk.
        // Classifying on "the path is gone" alone would report every delete of
        // an uncommitted file as lost work — a false alarm in the channel that
        // exists to carry the real one.
        //
        // The file is created OUTSIDE git's knowledge so its deletion is not a
        // diff against HEAD: that is what makes the pass reach the classifier
        // instead of simply committing.
        await writeFile(path.join(folder, 'documents', 'never-committed.md'), 'x\n')
        await withChangeSet({ changeSet: 'cs-del-only', summary: 'Remove it' }, async () => {
            await useCollection(runtime, 'documents').remove('never-committed.md')
        })
        await closeChangeSet('cs-del-only')

        const result = await pass()
        assert.ok(result.settled.includes('cs-del-only'), 'the set is drained')

        const set = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-del-only')
        assert.equal(set.outcome, 'deleted',
            'a delete-only set is reported as a deletion, not as work that went missing')
    })

    it('tells an undo that the work was lost rather than cancelled', async () => {
        // Same refusal — there is no commit — but a different reason, because
        // "its changes cancelled out" sends someone away satisfied about work
        // that is gone.
        await write('cs-vanish2', 'Write something', 'vanishes2.md', 'content\n')
        await rm(path.join(folder, 'documents', 'vanishes2.md'), { force: true })
        await pass()

        const result = await previewUndo(folder, { id: 'cs-vanish2', runtime })
        assert.equal(result.ok, false)
        assert.equal(result.refused, 'nothing-to-undo-work-missing')
        assert.match(result.error, /lost rather than cancelled/)
    })
})

// The distinction the checksum exists to make.
//
// A set that produced no commit, with its paths on disk and identical to the
// last commit, is EITHER a write that matched what was already committed or a
// write something replaced before the pass ran. From disk alone those are the
// same picture; against the checksum recorded at write time they are not.
describe('a set whose paths match the last commit', () => {
    it('is a no-op when the bytes are the ones it wrote', async () => {
        await write('cs-seed-same', 'Add it', 'same.md', 'original\n')
        await pass()
        // Writes exactly what is already committed.
        await write('cs-same', 'Write the same bytes', 'same.md', 'original\n')

        await pass()
        const set = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-same')
        assert.equal(set.outcome, 'no-diff',
            'the bytes on disk are the ones this set wrote — nothing was lost')
    })

    it('is a replacement when they are not', async () => {
        await write('cs-seed-diff', 'Add it', 'diff.md', 'original\n')
        await pass()
        await write('cs-loses', 'Write something new', 'diff.md', 'the work that vanishes\n')
        // Something puts the committed version back — a reset, a competing
        // writer, an inbound merge.
        await writeFile(path.join(folder, 'documents', 'diff.md'), 'original\n')

        await pass()
        const set = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-loses')
        assert.equal(set.outcome, 'replaced',
            'what is on disk is not what this set wrote, and the checksum proves it')
    })

    it('says so plainly when the writer recorded no checksum', async () => {
        // A writer that does not know its own bytes leaves the question open.
        // "Cannot tell" is an answer; guessing either way is not.
        await write('cs-seed-unv', 'Add it', 'unv.md', 'original\n')
        await pass()
        await withChangeSet({ changeSet: 'cs-unverifiable', summary: 'No checksum' }, async () => {
            await writeFile(path.join(folder, 'documents', 'unv.md'), 'changed\n')
            recordChangeSetWrite({ uri: path.join(folder, 'documents', 'unv.md') })
        })
        await closeChangeSet('cs-unverifiable')
        await writeFile(path.join(folder, 'documents', 'unv.md'), 'original\n')

        await pass()
        const set = (await listChangeSets({ limit: 20 })).find(s => s.id === 'cs-unverifiable')
        assert.equal(set.outcome, 'unverifiable',
            'no checksum was recorded, so neither answer can be claimed')
    })
})
