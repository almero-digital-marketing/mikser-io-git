// pullInbound must never throw.
//
// Its only caller is a timer, and a timer callback that rejects ends the
// process: Node has treated an unhandled rejection as fatal since v15 and
// mikser installs no process-level handler. The poll runs every few minutes
// for the life of a watch server, so a network blip, a DNS failure or an
// expired token would take down the build AND the site — and under a
// supervisor, do it in a loop.
//
// `git fetch` used to sit outside the try that guards the merges, which is
// exactly the call most likely to fail for reasons unrelated to this repo.
//
// Exercised against REAL repositories in temp directories, the same way
// git.test.js does it: lib/git.js is a thin execFile wrapper, its exports
// are ESM bindings that cannot be redefined, and a mock of git would be a
// test of the mock.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { format } from 'node:util'

import * as git from '../lib/git.js'
import { pullInbound } from '../lib/inbound.js'

// `text` is the raw arguments; `message` is the line as the logger prints
// it — the leading fields object dropped, %s filled in.
const collect = () => {
    const lines = []
    const push = (level) => (...args) => lines.push({
        level,
        text: args.join(' '),
        message: format(...(typeof args[0] === 'object' ? args.slice(1) : args)),
    })
    return { lines, warn: push('warn'), error: push('error'), info: push('info') }
}

const OPTS = { writeBranch: 'mikser', targetBranch: 'main' }

// Recorded for failure messages: this suite's behaviour has already differed
// between git versions, and the version is the first thing a reader needs.
let gitVersion = '(unknown)'

async function commit(folder, file, content, message) {
    await writeFile(path.join(folder, file), content)
    await git.run(folder, ['add', '-A'])
    await git.run(folder, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', message])
}

describe('pullInbound against real repositories', async () => {
    let root
    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-inbound-'))
        gitVersion = await git.run(root, ['--version']).catch(() => '(unknown)')
    })
    after(async () => { await rm(root, { recursive: true, force: true }) })

    // A working folder whose `origin` points at a real upstream repo.
    async function makePair(name) {
        const upstream = path.join(root, `${name}-upstream`)
        const local = path.join(root, name)
        await mkdir(upstream, { recursive: true })
        await git.run(upstream, ['init', '-q', '-b', 'main', '.'])
        await commit(upstream, 'page.md', 'original\n', 'init')
        await git.run(upstream, ['branch', 'mikser'])
        await git.run('.', ['clone', '-q', upstream, local])
        await git.run(local, ['checkout', '-q', 'mikser'])
        // A merge records a commit, so it needs a committer. `commit()` above
        // passes `-c user.*` per call, which covers commits and not merges —
        // so on a runner whose account has no real name to derive one from,
        // every merge here failed on `empty ident name` and the conflict case
        // was never reached. It passed anyway, because the code then called
        // any merge failure a conflict.
        await git.run(local, ['config', 'user.email', 'w@w'])
        await git.run(local, ['config', 'user.name', 'W'])
        return { upstream, local }
    }

    it('pushes commits an earlier failure left behind', async () => {
        // The real sequence, from lmed: the token expired, pushes failed, and
        // because pushWriteBranch only runs from the COMMIT path nothing ever
        // looked at those commits again. 113 of them sat on one container with
        // no copy anywhere else, while the site served fine and the tree was
        // clean. Recovery has to be automatic once the remote works again,
        // because the alternative is waiting for someone to save a file.
        const { upstream, local } = await makePair('backlog')
        await commit(local, 'edit.md', 'by an editor\n', 'content: an edit')
        assert.equal(await git.commitsAhead(local, 'mikser', 'origin/mikser'), 1)

        const logger = collect()
        const result = await pullInbound(local, { ...OPTS, logger })

        assert.equal(result.unpushed, 0, 'the backlog is cleared')
        assert.equal(await git.commitsAhead(local, 'mikser', 'origin/mikser'), 0)
        // And it really reached the other repository, not just a moved ref.
        assert.equal(await git.commitsAhead(upstream, 'mikser', 'main'), 1)
        assert.ok(logger.lines.some(l => l.level === 'info' && /left behind/.test(l.text)),
            `the recovery should say what it did: ${JSON.stringify(logger.lines)}`)
    })

    it('reports a backlog it cannot push as a coded fault', async () => {
        // Work that exists in exactly one place has to be said out loud. The
        // code makes it a fault: deduped, and visible in --json and
        // mikser_ping rather than only in a log nobody reads.
        const { local } = await makePair('backlog-stuck')
        await commit(local, 'edit.md', 'by an editor\n', 'content: an edit')
        // Fetch still works, the push does not — a read-only remote, which is
        // what an expired write token looks like.
        const readOnly = path.join(root, 'backlog-stuck-upstream')
        await git.run(readOnly, ['config', 'receive.denyCurrentBranch', 'refuse'])
        await git.run(readOnly, ['checkout', '-q', 'mikser'])

        const logger = collect()
        const result = await pullInbound(local, { ...OPTS, logger })

        assert.equal(result.unpushed, 1, 'the count survives so a caller can report it')
        const fault = logger.lines.find(l => l.level === 'error')
        assert.ok(fault, `a stranded commit is a fault: ${JSON.stringify(logger.lines)}`)
        assert.match(fault.text, /never reached the remote/)
    })

    it('reports a failed fetch instead of rejecting', async () => {
        const { local } = await makePair('badremote')
        // Point origin at a path that does not exist: a real fetch failure,
        // of the same class as a DNS failure or an expired token.
        await git.run(local, ['remote', 'set-url', 'origin', path.join(root, 'does-not-exist')])
        const logger = collect()

        // The assertion IS that this resolves. A rejection here is the
        // process ending in production.
        const result = await pullInbound(local, { ...OPTS, logger })

        assert.equal(result.merged, false)
        assert.equal(result.fetchFailed, true)
        assert.ok(result.reason, 'carries why')
        assert.equal(logger.lines[0].level, 'warn', 'a transient remote failure is a warning, not an error')
    })

    it('leaves the working folder untouched when the fetch fails', async () => {
        const { local } = await makePair('untouched')
        await git.run(local, ['remote', 'set-url', 'origin', path.join(root, 'does-not-exist')])

        await pullInbound(local, { ...OPTS, logger: collect() })

        assert.equal(await readFile(path.join(local, 'page.md'), 'utf8'), 'original\n')
        assert.equal(await git.run(local, ['status', '--porcelain']), '', 'no stray state')
    })

    it('merges when both branches move cleanly', async () => {
        const { upstream, local } = await makePair('clean')
        await commit(upstream, 'other.md', 'added upstream\n', 'upstream change')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])

        const result = await pullInbound(local, { ...OPTS, logger: collect() })

        assert.equal(result.merged, true)
        assert.equal(await readFile(path.join(local, 'other.md'), 'utf8'), 'added upstream\n')
    })

    it('merges on a host where git cannot derive an identity', async () => {
        // The deployment shape: a container running as a bare service user.
        // git guesses a committer from the OS account, that guess has no real
        // name, and git refuses the empty one — reaching `git merge`, not just
        // `git commit`, because a merge records a commit too. The plugin's
        // configured `author` is the identity it should be using anyway.
        //
        // `user.name=` empty is exactly the state git lands in when it cannot
        // derive one, and is reproducible on any machine.
        const { upstream, local } = await makePair('ident')
        // BOTH sides move, on different files. A fast-forward records no
        // commit at all, so it needs no identity and would pass this test
        // with the fix reverted.
        await commit(local, 'local.md', 'from the CMS\n', 'local change')
        await commit(upstream, 'other.md', 'added upstream\n', 'upstream change')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])
        await git.run(local, ['config', 'user.name', ''])

        const result = await pullInbound(local, {
            ...OPTS, author: { name: 'mikser', email: 'bot@example.com' }, logger: collect(),
        })

        assert.equal(result.merged, true, `the merge failed: ${result.reason}`)
        assert.equal(await readFile(path.join(local, 'other.md'), 'utf8'), 'added upstream\n')
    })

    it('still fails honestly when it has no identity and none is configured', async () => {
        // Unconfigured, git resolves it exactly as before — so this is the
        // message an operator gets, and it must not be dressed up as a
        // conflict. That mislabel is what hid the real cause for two releases.
        const { upstream, local } = await makePair('ident-none')
        await commit(local, 'local.md', 'from the CMS\n', 'local change')
        await commit(upstream, 'other.md', 'added upstream\n', 'upstream change')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])
        await git.run(local, ['config', 'user.name', ''])
        const logger = collect()

        const result = await pullInbound(local, { ...OPTS, logger })

        assert.equal(result.merged, false)
        assert.equal(result.conflictedRef, undefined, 'an identity failure is not a conflict')
        assert.ok(result.failedRef)
        assert.match(result.reason, /ident/i, 'the reason must name what git actually refused')
    })

    it('tells a merge that FAILED apart from a merge that conflicted', async () => {
        // Two different outcomes that shared one word. A conflict leaves
        // MERGE_HEAD and is abortable; a merge that never got that far — a
        // dirty file in its way, an LFS smudge filter that cannot
        // authenticate — does not, so `git merge --abort` exits "There is no
        // merge to abort" and the tree stays however the merge left it.
        //
        // Asked of MERGE_HEAD rather than inferred from whether the abort
        // succeeded: that reads an exit code for a question git will answer,
        // and the two are not the same question on every git version.
        const { upstream, local } = await makePair('blocked')
        await commit(upstream, 'page.md', 'upstream edit\n', 'upstream')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])
        // Uncommitted, and in the way: git refuses before starting.
        await writeFile(path.join(local, 'page.md'), 'an editor is mid-sentence\n')

        const result = await pullInbound(local, { ...OPTS, logger: collect() })

        assert.equal(result.merged, false)
        assert.equal(result.conflictedRef, undefined,
            'a merge that never started is not a conflict, and saying so sends the reader after markers that are not there')
        assert.ok(result.failedRef, 'names the branch it could not merge')
        assert.equal(result.dirty, true, 'the folder has changes, so it must not be reported as untouched')
        assert.equal(await readFile(path.join(local, 'page.md'), 'utf8'), 'an editor is mid-sentence\n',
            'the uncommitted edit must survive')
    })

    it('names the files that refused the merge, and says nothing was applied', async () => {
        // The words the generic failure uses — "may be part of the commit the
        // merge half-applied" — are false for this one. Git checks every file
        // before it writes any, so the tree is untouched, and the reader needs
        // the file that is in the way, not a half-merge to go looking for.
        const { upstream, local } = await makePair('refused')
        await commit(upstream, 'page.md', 'upstream edit\n', 'upstream')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])
        await writeFile(path.join(local, 'page.md'), 'an editor is mid-sentence\n')
        const head = await git.revParse(local, 'HEAD')
        const logger = collect()

        const result = await pullInbound(local, { ...OPTS, logger })

        const fault = logger.lines.find(l => l.level === 'error')
        const seen = `git ${gitVersion}; result ${JSON.stringify(result)}; log ${JSON.stringify(logger.lines)}`
        assert.deepEqual(result.blockedBy, ['page.md'], seen)
        assert.match(result.reason, /uncommitted edits to page\.md/, 'the held promote quotes this reason')
        assert.match(fault.message, /would overwrite uncommitted edits to page\.md/, seen)
        assert.match(fault.message, /nothing was applied/, seen)
        assert.doesNotMatch(fault.message, /half-applied/, seen)
        // No `paths`: the whole folder is in scope, so the sync pass will
        // commit it and nobody has to.
        assert.match(fault.message, /inside `paths`, so the next green cycle commits it/, seen)
        assert.equal(await git.revParse(local, 'HEAD'), head, 'HEAD did not move')
        assert.equal(await readFile(path.join(local, 'page.md'), 'utf8'), 'an editor is mid-sentence\n')
    })

    it('says a person has to clear a blocking file outside `paths`', async () => {
        // What held a live deployment: a hand edit to scripts/ on the server,
        // in a folder the plugin does not commit. Nothing would ever clear it,
        // so the refusal repeated every poll — and the log has to say that.
        const { upstream, local } = await makePair('refused-outside')
        await commit(upstream, 'page.md', 'upstream edit\n', 'upstream')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])
        await writeFile(path.join(local, 'page.md'), 'edited by hand on the server\n')
        const logger = collect()

        const result = await pullInbound(local, { ...OPTS, paths: ['documents'], logger })

        const fault = logger.lines.find(l => l.level === 'error')
        const seen = `result ${JSON.stringify(result)}; log ${JSON.stringify(logger.lines)}`
        assert.deepEqual(result.blockedBy, ['page.md'], seen)
        assert.match(fault.message, /page\.md is outside `paths`, so this plugin will never commit it/, seen)
        assert.match(fault.message, /git checkout -- <file>/, seen)
        assert.doesNotMatch(fault.message, /next green cycle/, seen)
    })

    it('names an untracked file the incoming commit would overwrite', async () => {
        const { upstream, local } = await makePair('refused-untracked')
        await commit(upstream, 'new.md', 'added upstream\n', 'upstream')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])
        await writeFile(path.join(local, 'new.md'), 'made here first\n')
        const logger = collect()

        const result = await pullInbound(local, { ...OPTS, logger })

        const fault = logger.lines.find(l => l.level === 'error')
        const seen = `result ${JSON.stringify(result)}; log ${JSON.stringify(logger.lines)}`
        assert.deepEqual(result.blockedBy, ['new.md'], seen)
        assert.match(fault.message, /untracked new\.md, which the commit adds/, seen)
        assert.equal(await readFile(path.join(local, 'new.md'), 'utf8'), 'made here first\n')
    })

    it('aborts a conflicted merge and leaves no conflict markers', async () => {
        // The reason abort-and-report is the only acceptable outcome: this
        // folder is mikser's live render source, so a half-applied merge
        // means the next cycle renders "<<<<<<< HEAD" as page content.
        const { upstream, local } = await makePair('conflict')
        await commit(local, 'page.md', 'local edit\n', 'local')
        await commit(upstream, 'page.md', 'upstream edit\n', 'upstream')
        await git.run(upstream, ['branch', '-f', 'mikser', 'main'])
        const logger = collect()

        const result = await pullInbound(local, { ...OPTS, logger })

        // The result and the log, in the failure message. `actual: undefined`
        // over `assert.ok(result.conflictedRef)` says only that it is absent,
        // which is the one thing already obvious — not which of the other
        // outcomes happened instead, and this classification has already
        // differed between git versions once.
        const evidence = () =>
            `\nresult: ${JSON.stringify(result)}\ngit: ${gitVersion}\nlog:\n  `
            + logger.lines.map(l => `[${l.level}] ${l.text}`).join('\n  ')

        assert.equal(result.merged, false, evidence())
        assert.ok(result.conflictedRef, `names which branch conflicted${evidence()}`)
        const content = await readFile(path.join(local, 'page.md'), 'utf8')
        assert.ok(!content.includes('<<<<<<<'), 'no conflict markers survive into the render source')
        assert.equal(content, 'local edit\n', 'local content is what remains')
        assert.match(logger.lines.at(-1).text, /conflict/i)
    })
})
