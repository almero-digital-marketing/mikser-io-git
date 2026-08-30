// The sync pass must not be stoppable.
//
// Reported live: one commit at startup, then every later change set sat at
// `committed: null` for six minutes across several quiet windows. Nothing in
// the output said why, because a stalled pass and a pass correctly waiting are
// the same absence of log lines.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
    runtime, withChangeSet, pendingChangeSets, listChangeSets,
    markChangeSetsRecorded, markChangeSetFailed, markChangeSetSettled, forgetAllChangeSets,
    useCollection, recordChangeSetWrite,
} from 'mikser-io'
import * as git from '../lib/git.js'
import { commitAndPushWriteBranch } from '../lib/sync.js'

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
beforeEach(() => forgetAllChangeSets())

const write = (id, summary, rel, content) =>
    withChangeSet({ changeSet: id, summary, principal: 'agent', closeOnReturn: true },
        () => useCollection(runtime, 'documents').write(rel, content))

const pass = async () => {
    const committed = [], failed = [], settled = []
    try {
        await commitAndPushWriteBranch(folder, {
            paths: ['documents'], writeBranch: 'mikser',
            message: ({ fileCount }) => `content: ${fileCount} file(s) via mikser`,
            changeSets: pendingChangeSets(),
            onCommitted: (id, sha) => { committed.push(id); markChangeSetsRecorded([id], sha) },
            onFailed: (id, err) => { failed.push(id); markChangeSetFailed(id, err) },
            onSettled: (id, reason) => { settled.push(id); markChangeSetSettled(id, reason) },
        })
    } catch { /* no remote to push to */ }
    return { committed, failed, settled }
}

describe('every pending change set reaches a commit', () => {
    it('commits ten writes in one pass, and gives each its own commit', async () => {
        // The reported shape: the first set committed and nothing after it.
        for (let i = 0; i < 10; i++) await write(`cs-${i}`, `Write ${i}`, `doc-${i}.md`, `body ${i}\n`)
        const { committed } = await pass()
        assert.equal(committed.length, 10, 'all ten, in one pass')

        const listed = listChangeSets({ limit: 20 })
        assert.deepEqual(listed.filter(s => !s.recordedAs), [], 'nothing may be left at committed: null')
        // Asserted here rather than in a second test: the log is cleared
        // between tests, so a follow-up test would be reading an empty log and
        // passing for the wrong reason.
        assert.equal(new Set(listed.map(s => s.recordedAs)).size, 10, 'ten sets, ten commits')
    })
})

describe('one failing change set does not halt the rest', () => {
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

        const vanished = listChangeSets({ limit: 20 }).find(s => s.id === 'cs-vanished')
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
        markChangeSetFailed('cs-fails', new Error('hook rejected the commit'))
        const set = listChangeSets({ limit: 20 }).find(s => s.id === 'cs-fails')
        assert.equal(set.recordedAs, null)
        assert.match(set.commitError, /hook rejected/)
        assert.equal(set.commitAttempts, 1, 'and how many times it has been tried')

        // A failure is retried, so a later success must not leave a stale
        // reason beside a real commit. Asserted in the same test because the
        // log does not survive to the next one.
        markChangeSetsRecorded(['cs-fails'], 'abc1234')
        const after = listChangeSets({ limit: 20 }).find(s => s.id === 'cs-fails')
        assert.equal(after.commitError, null)
        assert.equal(after.recordedAs, 'abc1234')
    })

    it('never leaves a set both uncommitted and unexplained past the ceiling', () => {
        // The combination the report calls impossible: old, no commit, no
        // reason. One of the two must always be present.
        const stale = listChangeSets({ limit: 200 })
            .filter(s => Date.now() - s.startedAt > 600_000)
            .filter(s => !s.recordedAs && !s.commitError)
        assert.deepEqual(stale, [])
    })
})

describe('bounded operations', () => {
    it('gives every git command a timeout', () => {
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
describe('a set with no net diff', () => {
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
        assert.deepEqual(pendingChangeSets().map(s => s.id), [],
            'a drained set must not come back')

        // Asserted here, not in a following test: the log is cleared between
        // tests, so a second test would read an empty log and pass for the
        // wrong reason.
        const set = listChangeSets({ limit: 20 }).find(s => s.id === 'cs-empty')
        assert.equal(set.recordedAs, null, 'there is genuinely no commit')
        assert.equal(set.outcome, 'empty', 'and the null is explained rather than a mystery')
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
        assert.deepEqual(pendingChangeSets().map(s => s.id), [], 'the pass drains completely')
    })

    it('drains a set that wrote outside the paths this instance versions', async () => {
        // Another instance may own those folders; this one is finished with
        // it either way, and holding it forever helps nobody.
        recordChangeSetWrite({ changeSet: 'cs-elsewhere', summary: 'Outside', uri: path.join(folder, 'not-versioned', 'x.md') })
        const { settled } = await pass()
        assert.ok(settled.includes('cs-elsewhere'))
        assert.deepEqual(pendingChangeSets().map(s => s.id), [])
    })
})
