// Remove one change set's contribution from the current state.
//
// Not "restore a previous state". The site has moved on — documents were added
// through the API, a human edited something — and the request is to take back
// ONE change while keeping everything that came after. That is a merge-shaped
// operation, which is exactly what `git revert` is for and exactly what a
// snapshot restore is not.
//
// Git handles the textual half. It cannot handle the other half: a document
// added after the change set may DEPEND on what the change set created, so a
// revert that applies with no conflict at all can still leave the site
// referencing a layout that no longer exists. Git reports success; the site is
// broken. That check needs the reference graph, so it happens here.

import { findEntities, lookupKeys } from 'mikser-io'

import * as git from './git.js'
import { parseChangeSetLog } from './changeset-commit.js'

// Change sets in the branch's history, newest first.
export async function listChangeSets(folder, { branch, limit = 20 } = {}) {
    const raw = await git.logChangeSets(folder, { branch, limit: limit * 3 })
    return parseChangeSetLog(raw).sort((a, b) => b.at - a.at).slice(0, limit)
}

export async function findChangeSet(folder, id, { branch } = {}) {
    const raw = await git.logChangeSets(folder, { branch, limit: 500, id })
    return parseChangeSetLog(raw).find(set => set.id === id) ?? null
}

// The reverse patch for a whole set: every commit undone, newest first.
//
// Newest-first because the commits stack — undoing the oldest edit to a file
// before the newest one would be applying a patch to content that has moved
// on since.
export async function reversePatchFor(folder, set) {
    const parts = []
    for (const sha of [...set.commits].reverse()) {
        const patch = await git.reversePatch(folder, sha)
        if (patch?.trim()) parts.push(patch)
    }
    return parts.join('\n')
}

// Paths the undo would touch, and which of them it would REMOVE.
//
// A removal is where the danger is: reverting a create deletes a file, and
// anything that came to depend on it since is what breaks.
export function pathsInPatch(patch) {
    const touched = new Set()
    const deleted = new Set()
    let current = null
    for (const line of String(patch ?? '').split('\n')) {
        const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
        if (m) { current = m[2]; touched.add(current); continue }
        // In a REVERSE patch, "new file mode" means the forward commit
        // deleted it and undoing restores it; "deleted file mode" means the
        // forward commit created it and undoing removes it.
        if (line.startsWith('deleted file mode') && current) deleted.add(current)
    }
    return { touched: [...touched], deleted: [...deleted] }
}

// What would still point at the things this undo removes.
//
// Uses the engine's own inverse reference index rather than a text search, so
// it sees a `$`-ref exactly the way invalidation does — and asks about every
// key the entity can be referenced BY (`lookupKeys`), not just its id, since
// content refers to served paths far more often than to catalog ids.
//
// Referrers belonging to the change set itself are excluded: undoing a
// document together with the layout only it used is coherent, and counting
// that as breakage would make every complete undo look dangerous.
export async function danglingAfterUndo({ runtime, deletedPaths, setPaths }) {
    const refs = runtime?.refs
    const workingFolder = runtime?.options?.workingFolder
    if (!refs?.inboundFor || !workingFolder || !deletedPaths.length) return []

    const own = new Set(setPaths)
    const relOf = (uri) => (uri && uri.startsWith(`${workingFolder}/`)
        ? uri.slice(workingFolder.length + 1)
        : null)

    const broken = []
    for (const rel of deletedPaths) {
        const [entity] = await findEntities({ uri: `${workingFolder}/${rel}` }) ?? []
        if (!entity) continue

        const referrers = new Map()
        for (const key of [entity.id, ...(lookupKeys(entity) ?? [])]) {
            if (!key) continue
            let inbound = []
            try { inbound = refs.inboundFor(key) ?? [] } catch { continue }
            for (const ref of inbound) {
                if (!ref?.id || ref.id === entity.id) continue
                referrers.set(ref.id, ref.field ?? null)
            }
        }

        const outside = []
        for (const [sourceId, field] of referrers) {
            const [source] = await findEntities({ id: sourceId }) ?? []
            const sourceRel = relOf(source?.uri)
            if (sourceRel && own.has(sourceRel)) continue
            outside.push({ id: sourceId, ...(field ? { field } : {}) })
        }
        if (outside.length) broken.push({ removes: rel, id: entity.id, referencedBy: outside })
    }
    return broken
}

// Everything a caller needs to decide, computed without touching the tree.
export async function previewUndo(folder, { id, branch, runtime } = {}) {
    const set = await findChangeSet(folder, id, { branch })
    if (!set) {
        return { ok: false, refused: 'unknown-change-set',
                 error: `No change set ${id} in this branch's history.` }
    }
    const patch = await reversePatchFor(folder, set)
    if (!patch.trim()) {
        return { ok: false, refused: 'nothing-to-undo', set,
                 error: 'That change set left nothing to reverse.' }
    }
    const { touched, deleted } = pathsInPatch(patch)
    const applies = await git.patchApplies(folder, patch)
    const dangling = await danglingAfterUndo({ runtime, deletedPaths: deleted, setPaths: touched })

    return {
        ok: true,
        set: { id: set.id, summary: set.summary, at: set.at, principal: set.principal, commits: set.commits.length },
        touched,
        removes: deleted,
        applies,
        dangling,
        patch,
        // Two independent reasons to stop, reported separately because the
        // answers differ: a conflict means "not automatically", dangling refs
        // mean "this will break something that arrived later".
        ...(applies ? {} : {
            conflict: 'A later change edited the same content, so this undo cannot be applied automatically.',
        }),
        ...(dangling.length ? {
            warning: `Undoing this removes ${dangling.length} entit${dangling.length === 1 ? 'y' : 'ies'} that `
                + 'something added since still references.',
        } : {}),
    }
}
