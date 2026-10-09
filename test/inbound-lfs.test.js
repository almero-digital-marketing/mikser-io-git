// An inbound commit introducing a BRAND-NEW Git-LFS object.
//
// Checking out an LFS-tracked file runs the smudge filter as its own process,
// and it resolves its endpoint from the remote being merged. Where that remote
// is HTTPS with no stored credentials, a daemon has nothing to answer the
// username prompt with and git-lfs fatals mid-checkout. Observed on a live
// deployment every thirty seconds:
//
//     fatal: could not read Username for 'https://git.almero.pro'
//     error: external filter 'git-lfs filter-process' failed
//     fatal: media/new.mp4: smudge filter lfs failed
//
// An object already in the local cache smudges with no network at all, so only
// a file NEW to an inbound commit hits it.
//
// WHAT MAKES IT DAMAGING rather than merely noisy, and what these tests pin:
// by the time the filter runs, the merge has already written the incoming
// commit's OTHER files. HEAD has not moved, there is no MERGE_HEAD for
// `--abort` to use, and the tree holds half the commit. Downstream cannot tell
// that from an editor's uncommitted work, so it gets committed and promoted —
// carrying a tree built on the commit BEFORE the new media.
//
// The setup mirrors the deployment rather than simulating it: `origin` is
// reachable for git (so the fetch and the merge both proceed, as they did
// there) and its LFS endpoint is unreachable, which is what an HTTPS remote
// with no credentials amounts to. A second remote can serve LFS, as the real
// repo's SSH `deploy` remote can.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import * as git from '../lib/git.js'
import { isSshUrl, missingObjects, candidateRemotes } from '../lib/lfs.js'
import { pullInbound } from '../lib/inbound.js'

const collect = () => {
    const lines = []
    const push = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') })
    return { lines, warn: push('warn'), error: push('error'), info: push('info'), debug: push('debug') }
}

const OPTS = { writeBranch: 'mikser', targetBranch: 'production' }
const AUTHOR = ['-c', 'user.email=t@t', '-c', 'user.name=T']

// An LFS endpoint nothing can reach, which is what an HTTPS remote with no
// stored credentials is to a daemon. Port 1 is never listening.
const DEAD_LFS = 'https://127.0.0.1:1/lfs'

let lfsAvailable = true

async function setupRepos(root) {
    const forge = path.join(root, 'forge.git')
    const author = path.join(root, 'author')
    const work = path.join(root, 'work')

    await git.run(root, ['init', '--quiet', '--bare', 'forge.git'])
    await git.run(root, ['clone', '--quiet', forge, 'author'])
    await git.run(author, ['lfs', 'track', 'media/*.mp4'])
    await mkdir(path.join(author, 'media'), { recursive: true })
    // Random bytes, so a later assertion on content cannot pass by accident.
    await writeFile(path.join(author, 'media/old.mp4'), randomBytes(3000))
    await writeFile(path.join(author, 'sibling.txt'), 'first\n')
    await git.run(author, ['add', '-A'])
    await git.run(author, [...AUTHOR, 'commit', '-m', 'initial, one LFS object'])
    await git.run(author, ['push', '--quiet', 'origin', 'HEAD:production'])

    await git.run(root, ['clone', '--quiet', '--branch', 'production', forge, 'work'])
    await git.run(work, ['checkout', '--quiet', '-b', 'mikser'])
    // The write branch exists on the forge, as it does on a deployment that
    // has run once. Without it the merge of origin/mikser fails first and
    // hides the case under test.
    await git.run(work, ['push', '--quiet', 'origin', 'HEAD:mikser'])
    await git.run(work, ['fetch', '--quiet', 'origin'])
    // The working folder's own `origin` can serve git but not LFS.
    await git.run(work, ['config', 'remote.origin.lfsurl', DEAD_LFS])
    // …and a second remote that can, like the real repo's SSH `deploy`.
    await git.run(work, ['remote', 'add', 'deploy', forge])

    return { forge, author, work }
}

// The inbound commit: a new LFS object AND an ordinary edit beside it. The
// sibling is what proves the merge is all-or-nothing — it is the file that was
// left applied in the working folder on the live deployment.
async function pushNewLfsCommit(author, { name = 'new.mp4' } = {}) {
    await writeFile(path.join(author, `media/${name}`), randomBytes(4000))
    await writeFile(path.join(author, 'sibling.txt'), 'first\nsecond\n')
    await git.run(author, ['add', '-A'])
    await git.run(author, [...AUTHOR, 'commit', '-m', `add media/${name}`])
    await git.run(author, ['push', '--quiet', 'origin', 'HEAD:production'])
    return git.run(author, ['rev-parse', 'HEAD'])
}

describe('an inbound commit adding a new Git-LFS object', () => {
    let root, repos
    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-git-lfs-'))
        try {
            await git.run(root, ['lfs', 'version'])
        } catch {
            lfsAvailable = false
            return
        }
        repos = await setupRepos(root)
    })
    after(async () => { await rm(root, { recursive: true, force: true }) })

    it('merges, and HEAD advances to the new commit', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        const incoming = await pushNewLfsCommit(repos.author)
        const logger = collect()

        const result = await pullInbound(repos.work, { ...OPTS, lfsRemote: 'deploy', logger })

        assert.equal(result.merged, true,
            `merge did not complete: ${result.reason}\n${logger.lines.map(l => l.text).join('\n')}`)
        assert.equal(await git.run(repos.work, ['rev-parse', 'HEAD']), incoming,
            'HEAD did not advance to the inbound commit')
    })

    it('puts the real bytes on disk, not a pointer', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        // A merge run with the smudge disabled would also "succeed" and leave
        // a 130-byte pointer where the video belongs — and this working folder
        // is what the site serves.
        const file = path.join(repos.work, 'media/new.mp4')
        assert.equal((await stat(file)).size, 4000, 'not the full object')
        const head = (await readFile(file)).subarray(0, 40).toString('utf8')
        assert.doesNotMatch(head, /^version https:\/\/git-lfs/, 'the file is still an LFS pointer')
    })

    it('brings the sibling edit with it and leaves the folder clean', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        assert.equal(await readFile(path.join(repos.work, 'sibling.txt'), 'utf8'), 'first\nsecond\n')
        assert.equal(await git.hasChanges(repos.work), false,
            'the merge left uncommitted changes behind')
    })

    it('says which remote it fetched from', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        // The operator has to be able to tell that the LFS path was exercised
        // at all — otherwise a repo that silently stopped needing it looks the
        // same as one where this never ran.
        const logger = collect()
        await pushNewLfsCommit(repos.author, { name: 'second.mp4' })
        const result = await pullInbound(repos.work, { ...OPTS, lfsRemote: 'deploy', logger })
        assert.equal(result.merged, true, result.reason)
        // The collector joins pino's format string and its arguments rather
        // than formatting them, so the remote name arrives as a trailing arg.
        assert.ok(
            logger.lines.some(l => /fetched .*LFS object/.test(l.text) && /\bdeploy\b/.test(l.text)),
            `no line named the remote:\n${logger.lines.map(l => l.text).join('\n')}`)
    })
})

describe('when no remote can serve the LFS objects', () => {
    let root, repos
    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-git-lfs-dead-'))
        try {
            await git.run(root, ['lfs', 'version'])
        } catch {
            lfsAvailable = false
            return
        }
        repos = await setupRepos(root)
        // Take the working remote away: now every remote's LFS is unreachable,
        // which is the state the deployment was actually in before the fix.
        await git.run(repos.work, ['config', 'remote.deploy.lfsurl', DEAD_LFS])
        await pushNewLfsCommit(repos.author)
    })
    after(async () => { await rm(root, { recursive: true, force: true }) })

    it('does not start the merge, and leaves the folder genuinely untouched', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        const before = await git.run(repos.work, ['rev-parse', 'HEAD'])
        const logger = collect()

        const result = await pullInbound(repos.work, { ...OPTS, logger })

        assert.equal(result.merged, false)
        assert.equal(result.lfsBlockedRef, 'production',
            'the block must name the branch, so the next layer can decide')
        assert.equal(await git.run(repos.work, ['rev-parse', 'HEAD']), before, 'HEAD moved')
        // The whole point of checking before merging. Starting it would apply
        // sibling.txt and then fatal, leaving work nothing can distinguish
        // from an editor's.
        assert.equal(await git.hasChanges(repos.work), false,
            'the working folder was modified by a merge that could not finish')
        assert.equal(await readFile(path.join(repos.work, 'sibling.txt'), 'utf8'), 'first\n',
            'the sibling file carries half of the inbound commit')
    })

    it('never throws, whatever the remotes do', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        // Its caller is a poll timer; an unhandled rejection ends the process.
        await assert.doesNotReject(() => pullInbound(repos.work, { ...OPTS, logger: collect() }))
    })

    it('reports it loudly, with the command that fixes it', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        const logger = collect()
        await pullInbound(repos.work, { ...OPTS, logger })
        const errors = logger.lines.filter(l => l.level === 'error')
        assert.ok(errors.length, 'a silent skip is the 30-second loop all over again')
        const text = errors.map(l => l.text).join('\n')
        assert.match(text, /git lfs fetch/, 'does not say how to recover')
        assert.match(text, /media\/new\.mp4/, 'does not name the file')
        assert.doesNotMatch(text, /conflict/i,
            'calling a smudge failure a conflict sends the reader after markers that are not there')
    })
})

describe('the ref an LFS fetch is given', () => {
    // The trap that made the manual recovery look like a git-lfs bug.
    //
    // git-lfs resolves the ref LOCALLY to decide which pointers to download.
    // A bare branch name resolves to the LOCAL branch — for an inbound merge,
    // the commit that does not carry the new pointers yet — so it fetches
    // nothing. And it exits ZERO doing it, which is why a caller cannot read
    // success from the exit code.
    let root, repos
    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-git-lfs-ref-'))
        try {
            await git.run(root, ['lfs', 'version'])
        } catch {
            lfsAvailable = false
            return
        }
        repos = await setupRepos(root)
        await pushNewLfsCommit(repos.author)
        await git.run(repos.work, ['fetch', '--quiet', 'origin'])
    })
    after(async () => { await rm(root, { recursive: true, force: true }) })

    it('the branch name fetches nothing, and says nothing is wrong', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        assert.equal((await missingObjects(repos.work, 'origin/production')).missing.length, 1,
            'the object should be missing before anything is fetched')

        // Exits zero. This is `git lfs fetch deploy production` — the command
        // that looked like it worked and did not.
        await git.lfsFetch(repos.work, 'deploy', 'production')

        assert.equal((await missingObjects(repos.work, 'origin/production')).missing.length, 1,
            'the branch name fetched the object after all, so this no longer documents the trap')
    })

    it('the remote-tracking ref is the one that carries the new pointers', async (t) => {
        if (!lfsAvailable) return t.skip('git-lfs is not installed')
        await git.lfsFetch(repos.work, 'deploy', 'origin/production')
        assert.equal((await missingObjects(repos.work, 'origin/production')).missing.length, 0)
    })
})

describe('choosing the remote to fetch LFS objects from', () => {
    it('recognises both SSH spellings and no other', () => {
        assert.equal(isSshUrl('git@git.almero.pro:almero/gpoint-premium.git'), true)
        assert.equal(isSshUrl('ssh://git@git.almero.pro/almero/repo.git'), true)
        assert.equal(isSshUrl('https://git.almero.pro/almero/repo.git'), false)
        // The one that reads as scp-like because of the colon in the scheme.
        assert.equal(isSshUrl('https://user@git.almero.pro:8443/a/b.git'), false)
        assert.equal(isSshUrl('/srv/git/repo.git'), false)
        assert.equal(isSshUrl(undefined), false)
    })

    it('prefers the configured remote, then SSH, then the one being merged', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'mikser-git-remotes-'))
        try {
            await git.run(root, ['init', '--quiet', 'repo'])
            const repo = path.join(root, 'repo')
            await git.run(repo, ['remote', 'add', 'origin', 'https://git.almero.pro/a/b.git'])
            await git.run(repo, ['remote', 'add', 'deploy', 'git@git.almero.pro:a/b.git'])

            assert.deepEqual(await candidateRemotes(repo, { configured: 'deploy' }),
                ['deploy', 'origin'])
            // Unconfigured: SSH first, because key auth is what a daemon has
            // and an unauthenticated HTTPS remote is the thing that fatals.
            assert.deepEqual(await candidateRemotes(repo, {}), ['deploy', 'origin'])
            // A configured name that does not exist is ignored, not trusted
            // into the list — it would just cost a failed fetch per poll.
            assert.deepEqual(await candidateRemotes(repo, { configured: 'typo' }),
                ['deploy', 'origin'])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('reports a repo with no LFS as nothing to do', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'mikser-git-nolfs-'))
        try {
            await git.run(root, ['init', '--quiet', 'repo'])
            const repo = path.join(root, 'repo')
            await writeFile(path.join(repo, 'a.txt'), 'hello\n')
            await git.run(repo, ['add', '-A'])
            await git.run(repo, [...AUTHOR, 'commit', '-m', 'one'])
            const result = await missingObjects(repo, 'HEAD')
            assert.deepEqual(result.missing, [],
                'a repo that has never used LFS must cost nothing and block nothing')
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
