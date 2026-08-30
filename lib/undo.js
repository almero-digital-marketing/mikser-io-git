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

import {
    findEntities, lookupKeys,
    listChangeSets as engineChangeSets, findChangeSet as engineChangeSet,
} from 'mikser-io'

import * as git from './git.js'
import { parseChangeSetLog } from './changeset-commit.js'

// Change sets, newest first, read from the ENGINE's log.
//
// Not from `git log --grep`: a set exists the moment the write happens, and
// the commit that carries it may be a debounce window away or may never come
// at all if no git instance is configured. Reading the history made the id an
// agent was just handed resolve to nothing, which is exactly the gap the id
// is supposed to close.
//
// The trailers are still written, so git history stays self-describing and a
// human reading `git log` sees the same grouping. They are no longer what
// resolution depends on.
export async function listChangeSets(folder, { limit = 20 } = {}) {
    return engineChangeSets({ limit })
}

export async function findChangeSet(folder, id) {
    return engineChangeSet(id)
}

// Is the commit a set maps to actually reachable from here?
//
// A set can be recorded, committed, and then left behind by a branch switch
// or a history the deploy replaced. "Not on this branch" is a different
// problem from "never existed", and an agent told the wrong one goes looking
// in the wrong place.
export async function commitReachable(folder, sha, branch) {
    if (!sha) return false
    try {
        await git.run(folder, ['merge-base', '--is-ancestor', sha, branch ?? 'HEAD'])
        return true
    } catch {
        return false
    }
}

// The reverse patch for a set, from the commit it was recorded as.
//
// Scoped to the paths the SET claimed rather than the whole commit: the two
// are the same today, since a change-set commit stages exactly those paths,
// and staying scoped means a commit that ever carries more cannot widen an
// undo beyond what the set actually did.
export async function reversePatchFor(folder, set) {
    if (!set?.recordedAs) return ''
    const patch = await git.reversePatch(folder, set.recordedAs, set.paths)
    return patch?.trim() ? patch : ''
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
    const set = await findChangeSet(folder, id)
    if (!set) {
        // What the log actually holds decides the sentence. Suggesting an id
        // aged out of a log that has never held anything sends a reader
        // looking for a retention problem instead of a broken one — and an
        // empty log after a write that returned an id is a fault, not a
        // lookup miss.
        const known = engineChangeSets({ limit: 200 })
        return {
            ok: false,
            refused: 'unknown-change-set',
            logSize: known.length,
            error: known.length
                ? `No change set ${id} among the ${known.length} in the log. Ids come from mikser_changes; the log `
                    + 'keeps the most recent changes, so an old one may have aged out.'
                : `No change set ${id} — the log is EMPTY. Nothing has been recorded at all, so this is not a `
                    + 'lookup miss: writes are not reaching the log. Check the engine startup output for a '
                    + 'change-set log error.',
        }
    }
    // Recorded but not yet carried by a commit. Real, listable, and nothing
    // to revert from — which is why it does not report as unknown.
    if (!set.recordedAs) {
        return {
            ok: false, refused: 'not-yet-committed', set,
            ...(set.commitError ? { commitError: set.commitError } : {}),
            error: set.commitError
                // A failure and a wait are different states and need different
                // sentences. "Not yet" for something that will never happen
                // sends a reader back to wait again.
                ? `That change could not be committed — ${set.commitError}. It stays in the log and is retried, `
                    + 'but until the cause is fixed there is nothing to revert from.'
                : 'That change is recorded but has not been committed yet, so there is nothing to revert from. '
                    + 'It is committed on the next sync pass, or never if no git instance is configured for these '
                    + 'paths — in which case undo does not apply and the files are yours to edit back.',
        }
    }
    if (!(await commitReachable(folder, set.recordedAs, branch))) {
        return {
            ok: false, refused: 'not-on-this-branch', set,
            error: `The commit that carried this change (${set.recordedAs.slice(0, 8)}) is not reachable from `
                + `${branch ?? 'HEAD'} — a branch switch or a replaced history left it behind. Undo cannot reach `
                + 'it from here.',
        }
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
        set: {
            id: set.id, summary: set.summary, at: set.startedAt,
            principal: set.principal, files: set.paths.length, commit: set.recordedAs,
        },
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
