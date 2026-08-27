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

import * as git from '../lib/git.js'
import { pullInbound } from '../lib/inbound.js'

const collect = () => {
    const lines = []
    const push = (level) => (...args) => lines.push({ level, text: args.join(' ') })
    return { lines, warn: push('warn'), error: push('error'), info: push('info') }
}

const OPTS = { writeBranch: 'mikser', targetBranch: 'main' }

async function commit(folder, file, content, message) {
    await writeFile(path.join(folder, file), content)
    await git.run(folder, ['add', '-A'])
    await git.run(folder, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', message])
}

describe('pullInbound against real repositories', () => {
    let root
    before(async () => { root = await mkdtemp(path.join(tmpdir(), 'mikser-inbound-')) })
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
        return { upstream, local }
    }

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

        assert.equal(result.merged, false)
        assert.ok(result.conflictedRef, 'names which branch conflicted')
        const content = await readFile(path.join(local, 'page.md'), 'utf8')
        assert.ok(!content.includes('<<<<<<<'), 'no conflict markers survive into the render source')
        assert.equal(content, 'local edit\n', 'local content is what remains')
        assert.match(logger.lines.at(-1).text, /conflict/i)
    })
})
