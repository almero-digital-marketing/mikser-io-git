// isNonFastForwardError is pure string-matching, tested directly.
// Everything else in lib/git.js is a thin execFile wrapper — real
// confidence there comes from exercising it against an actual git
// repo in a temp directory. This only covers the LOCAL-only
// operations (init, add, commit, status, branch) — clone/fetch/push
// need a real remote and are exercised by hand against a real forge,
// not in this suite.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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

// The hard scope boundary the working-folder-as-checkout model depends
// on: mikser.config.js, node_modules/, runtime/, out/, .env can live in
// the SAME checkout this plugin manages, alongside collections it
// SHOULD auto-commit (documents/, layouts/), as long as every git
// operation is scoped to `paths`. Proven directly here, not assumed.
describe('git.js pathspec scoping (paths param)', () => {
    let dir

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'mikser-git-scope-'))
        await git.run(dir, ['init', '-b', 'main'])
        await git.run(dir, ['config', 'user.email', 'test@example.com'])
        await git.run(dir, ['config', 'user.name', 'Test'])
        await mkdir(path.join(dir, 'documents'))
        await mkdir(path.join(dir, 'node_modules'))
        await writeFile(path.join(dir, 'mikser.config.js'), 'export default {}')
        await writeFile(path.join(dir, 'documents', 'post.md'), 'hello')
        await writeFile(path.join(dir, 'node_modules', 'dep.js'), 'module.exports = {}')
        await git.addAll(dir)   // baseline commit — everything present so far
        await git.commit(dir, 'baseline')
    })

    after(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('statusPorcelain with paths only reports changes inside the scope', async () => {
        await writeFile(path.join(dir, 'documents', 'post.md'), 'edited')          // in scope
        await writeFile(path.join(dir, 'mikser.config.js'), 'export default { x: 1 }')  // OUT of scope
        await writeFile(path.join(dir, 'node_modules', 'dep.js'), 'changed')        // OUT of scope

        const scoped = await git.statusPorcelain(dir, ['documents'])
        assert.match(scoped, /post\.md/)
        assert.doesNotMatch(scoped, /mikser\.config\.js/)
        assert.doesNotMatch(scoped, /dep\.js/)

        // Unscoped status proves the OTHER files really were dirty —
        // the scoped call above wasn't just quiet because nothing changed.
        const unscoped = await git.statusPorcelain(dir)
        assert.match(unscoped, /mikser\.config\.js/)
        assert.match(unscoped, /dep\.js/)
    })

    it('addAll with paths stages only the in-scope file — the config edit stays untracked', async () => {
        await git.addAll(dir, ['documents'])
        assert.equal(await git.hasStagedChanges(dir, ['documents']), true)
        // Prove mikser.config.js's edit was NOT staged: the unscoped
        // status must still show it as an unstaged modification (' M'),
        // not staged ('M ').
        const status = await git.statusPorcelain(dir)
        assert.match(status, / M mikser\.config\.js/)
        assert.doesNotMatch(status, /^M {2}mikser\.config\.js/m)

        await git.commit(dir, 'documents-only change')

        // The committed tree must NOT include the config edit or the
        // node_modules change — only documents/post.md's new content.
        const committed = await git.run(dir, ['show', '--stat', 'HEAD'])
        assert.match(committed, /documents\/post\.md/)
        assert.doesNotMatch(committed, /mikser\.config\.js/)
        assert.doesNotMatch(committed, /dep\.js/)
    })

    it('a brand-new directory outside paths is invisible to a scoped add, even with --untracked-files=all', async () => {
        await mkdir(path.join(dir, 'layouts'))
        await writeFile(path.join(dir, 'layouts', 'post.hbs'), '<html></html>')

        await git.addAll(dir, ['documents'])   // layouts/ deliberately not in scope
        assert.equal(await git.hasStagedChanges(dir, ['documents']), false, 'nothing new in documents/ this round')
        assert.equal(await git.hasStagedChanges(dir, ['layouts']), false, 'layouts/ was never staged — out of scope')

        const unscoped = await git.statusPorcelain(dir)
        assert.match(unscoped, /layouts\//)   // still genuinely untracked, just untouched by the scoped add
    })
})
