// Undo one change set without destroying what happened around it.
//
// The scenario this exists for: an agent makes a change, a document is then
// created through the API, and the agent's change is undone. Staging by
// FOLDER — which is what the durable-log sweep does — puts both in the same
// commit, so reverting the agent's work deletes the API's document. The
// commit's contents have to match its label.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as git from '../lib/git.js'
import { commitAndPushWriteBranch } from '../lib/sync.js'
import { runtime } from 'mikser-io'
import { registerUndoTools } from '../lib/mcp.js'
import { listChangeSets, findChangeSet, reversePatchFor, pathsInPatch, danglingAfterUndo } from '../lib/undo.js'
import { parseChangeSetLog, changeSetTrailers } from '../lib/changeset-commit.js'

let folder

// A real repo. The whole point is git's actual staging and patch behaviour,
// which a mock would let us assume rather than verify.
before(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mikser-undo-'))
    await git.run(folder, ['init', '-b', 'mikser'])
    await git.run(folder, ['config', 'user.email', 'test@example.com'])
    await git.run(folder, ['config', 'user.name', 'Test'])
    await mkdir(path.join(folder, 'documents'), { recursive: true })
    await writeFile(path.join(folder, 'documents', 'seed.md'), 'seed\n')
    await git.run(folder, ['add', '-A'])
    await git.run(folder, ['commit', '-m', 'seed'])
})
after(async () => { if (folder) await rm(folder, { recursive: true, force: true }) })

const doc = (name) => path.join(folder, 'documents', name)
// commitAndPushWriteBranch pushes; there is no remote here, so the push throws
// after the commit lands. The commit is what these tests are about.
const commit = async (changeSets) => {
    try {
        await commitAndPushWriteBranch(folder, {
            paths: ['documents'], writeBranch: 'mikser',
            message: ({ fileCount }) => `content: ${fileCount} file(s) via mikser`,
            changeSets, onCommitted: () => {},
        })
    } catch { /* no remote */ }
}

describe('change-set commits', () => {
    it('stages only the paths its own change set wrote', async () => {
        // The agent writes one file.
        await writeFile(doc('agent.md'), 'agent v1\n')
        // Before the commit fires, something else creates a document.
        await writeFile(doc('via-api.md'), 'created through the API\n')

        await commit([{ id: 'cs-1', summary: 'Agent edits agent.md', paths: ['documents/agent.md'] }])

        const log = await git.run(folder, ['log', '--format=%s'])
        assert.match(log, /Agent edits agent\.md/, 'the change set commits under its own summary')

        // Two commits: the claimed set, then the unattributed sweep.
        const files = await git.run(folder, ['show', '--name-only', '--format=', 'HEAD~1'])
        assert.equal(files.trim(), 'documents/agent.md',
            'the change-set commit must contain ONLY what that set wrote')

        const sweep = await git.run(folder, ['show', '--name-only', '--format=', 'HEAD'])
        assert.equal(sweep.trim(), 'documents/via-api.md',
            'everything else lands in the unattributed sweep')
    })

    it('stamps the trailer that makes a commit undoable', async () => {
        const body = await git.run(folder, ['log', '--format=%b', '-1', 'HEAD~1'])
        assert.match(body, /Mikser-Change-Set: cs-1/)
        const sweepBody = await git.run(folder, ['log', '--format=%b', '-1', 'HEAD'])
        assert.doesNotMatch(sweepBody, /Mikser-Change-Set/,
            'the sweep must NOT be stamped — that trailer is the permission boundary')
    })
})

describe('undoing one change set', () => {
    it('finds only stamped commits', async () => {
        const sets = await listChangeSets(folder, { branch: 'mikser' })
        assert.deepEqual(sets.map(s => s.id), ['cs-1'],
            'the unattributed sweep is not offered as undoable')
    })

    it('removes the change set and leaves the API document alone', async () => {
        // THE SCENARIO. Undo the agent's change; the document created through
        // the API in the same window must survive.
        const set = await findChangeSet(folder, 'cs-1', { branch: 'mikser' })
        const patch = await reversePatchFor(folder, set)
        assert.equal(await git.patchApplies(folder, patch), true)
        await git.applyPatch(folder, patch)

        await assert.rejects(() => stat(doc('agent.md')), 'the agent\'s file is gone')
        assert.equal(await readFile(doc('via-api.md'), 'utf8'), 'created through the API\n',
            'the API document must survive the undo')
        assert.equal(await readFile(doc('seed.md'), 'utf8'), 'seed\n')
    })
})

describe('what a patch would touch', () => {
    it('separates edits from removals', () => {
        const patch = [
            'diff --git a/documents/kept.md b/documents/kept.md',
            'index 111..222 100644',
            '--- a/documents/kept.md',
            '+++ b/documents/kept.md',
            'diff --git a/layouts/promo.liquid b/layouts/promo.liquid',
            'deleted file mode 100644',
        ].join('\n')
        const { touched, deleted } = pathsInPatch(patch)
        assert.deepEqual(touched, ['documents/kept.md', 'layouts/promo.liquid'])
        assert.deepEqual(deleted, ['layouts/promo.liquid'],
            'only removals can leave something dangling')
    })
})

describe('trailer parsing', () => {
    it('groups commits belonging to one set', () => {
        const log = [
            ['b2', '1700000200', 'Agent edits', 'Mikser-Change-Set: cs-9\nMikser-Principal: agent'].join('\x1f'),
            ['b1', '1700000100', 'Agent edits', 'Mikser-Change-Set: cs-9'].join('\x1f'),
        ].join('\x1e') + '\x1e'
        const [set] = parseChangeSetLog(log)
        assert.equal(set.id, 'cs-9')
        assert.equal(set.principal, 'agent')
        assert.deepEqual(set.commits, ['b1', 'b2'], 'oldest first, so a revert can walk them backwards')
    })

    it('ignores commits with no change set', () => {
        const log = ['abc', '1700000000', 'content: 2 file(s) via mikser', ''].join('\x1f') + '\x1e'
        assert.deepEqual(parseChangeSetLog(log), [])
    })

    it('round-trips what it writes', () => {
        const trailers = changeSetTrailers({ id: 'cs-7', principal: 'agent', undoOf: 'cs-3' })
        const log = ['sha', '1700000000', 'Undo: something', trailers].join('\x1f') + '\x1e'
        const [set] = parseChangeSetLog(log)
        assert.equal(set.id, 'cs-7')
        assert.equal(set.undoOf, 'cs-3')
    })
})

// The other half of the scenario: the document added afterwards DEPENDS on
// what the agent's change set created. Nothing conflicts textually — different
// files — so git reverts cleanly and the site breaks anyway. Only the
// reference graph can see it coming.
describe('undo that would leave references dangling', () => {
    const withCatalog = (entities, inbound) => {
        runtime.options = { ...runtime.options, workingFolder: folder }
        runtime.catalog = { byId: new Map(entities.map(e => [e.id, e])) }
        runtime.refs = { inboundFor: (key) => inbound[key] ?? [] }
    }

    it('names what would be left pointing at nothing', async () => {
        const promo = { id: '/layouts/promo.liquid', uri: `${folder}/layouts/promo.liquid`, meta: {} }
        const later = { id: '/documents/later.md', uri: `${folder}/documents/later.md`, meta: {} }
        withCatalog([promo, later], { '/layouts/promo.liquid': [{ id: later.id, field: 'layout', kind: 'ref' }] })

        const dangling = await danglingAfterUndo({
            runtime,
            deletedPaths: ['layouts/promo.liquid'],
            setPaths: ['layouts/promo.liquid'],
        })
        assert.equal(dangling.length, 1)
        assert.equal(dangling[0].removes, 'layouts/promo.liquid')
        assert.deepEqual(dangling[0].referencedBy.map(r => r.id), ['/documents/later.md'])
    })

    it('does not count referrers the undo removes too', async () => {
        // Undoing a document together with the layout only it used is
        // coherent. Reporting it would make every complete undo look unsafe.
        const promo = { id: '/layouts/promo.liquid', uri: `${folder}/layouts/promo.liquid`, meta: {} }
        const page  = { id: '/documents/page.md', uri: `${folder}/documents/page.md`, meta: {} }
        withCatalog([promo, page], { '/layouts/promo.liquid': [{ id: page.id, field: 'layout', kind: 'ref' }] })

        const dangling = await danglingAfterUndo({
            runtime,
            deletedPaths: ['layouts/promo.liquid'],
            setPaths: ['layouts/promo.liquid', 'documents/page.md'],
        })
        assert.deepEqual(dangling, [])
    })

    it('says nothing when the undo removes nothing', async () => {
        withCatalog([], {})
        assert.deepEqual(await danglingAfterUndo({ runtime, deletedPaths: [], setPaths: ['a.md'] }), [])
    })
})

// A sync that rejects must not end the process.
//
// The tool fires it without awaiting — a network push is not something a tool
// call should block on — and Node has ended the process on an unhandled
// rejection since v15. mikser installs no handler, so a floating promise here
// is fatal rather than noisy.
describe('the sync nudge cannot kill the process', () => {
    let own

    // Its own repo with a fresh, still-applicable change set. Reusing the
    // shared fixture would reach `refused: conflict` before the nudge and pass
    // without ever running the code under test.
    const fixture = async () => {
        own = await mkdtemp(path.join(tmpdir(), 'mikser-undo-sync-'))
        await git.run(own, ['init', '-b', 'mikser'])
        await git.run(own, ['config', 'user.email', 'test@example.com'])
        await git.run(own, ['config', 'user.name', 'Test'])
        await mkdir(path.join(own, 'documents'), { recursive: true })
        await writeFile(path.join(own, 'documents', 'seed.md'), 'seed\n')
        await git.run(own, ['add', '-A'])
        await git.run(own, ['commit', '-m', 'seed'])
        await writeFile(path.join(own, 'documents', 'a.md'), 'v1\n')
        await git.addPaths(own, ['documents/a.md'])
        await git.run(own, ['commit', '-m', 'Agent edit\n\nMikser-Change-Set: cs-sync'])
        return own
    }

    const toolsWith = (sync, folder) => {
        const tools = new Map()
        registerUndoTools({ simpleTool: (n, _d, _s, h) => tools.set(n, h) }, {
            folder, writeBranch: 'mikser', runtime,
            useLogger: () => ({ error: () => {} }),
            isInert: () => false,
            sync,
        })
        return tools
    }

    after(async () => { if (own) await rm(own, { recursive: true, force: true }) })

    it('survives a sync that rejects', async () => {
        const folder = await fixture()
        runtime.options = { ...runtime.options, workingFolder: folder }
        const tools = toolsWith(() => Promise.reject(new Error('remote unreachable')), folder)

        let unhandled = null
        const onUnhandled = (err) => { unhandled = err }
        process.on('unhandledRejection', onUnhandled)
        try {
            const r = JSON.parse((await tools.get('mikser_undo')({ id: 'cs-sync', dryRun: false })).content[0].text)
            assert.equal(r.ok, true, 'the undo must actually reach the nudge, or this test proves nothing')
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
        assert.equal(unhandled, null, 'a rejected sync must not surface as an unhandled rejection')
    })

    it('survives a sync that throws synchronously', async () => {
        const folder = await fixture()
        runtime.options = { ...runtime.options, workingFolder: folder }
        const tools = toolsWith(() => { throw new Error('queue exploded') }, folder)
        const r = JSON.parse((await tools.get('mikser_undo')({ id: 'cs-sync', dryRun: false })).content[0].text)
        assert.equal(r.ok, true, 'the tool still answers')
    })
})
