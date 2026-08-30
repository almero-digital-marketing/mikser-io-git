// The trailer format that makes a commit undoable.
//
// Trailers rather than tags or notes: a tag per change set means thousands of
// refs, and notes are not fetched by default so they vanish on the next clone.
// Trailers are ordinary commit-message lines, they survive every normal git
// operation, and `git log --grep` finds them.
//
// The change-set id is also the PERMISSION boundary, not only the grouping
// key. Undo reverts commits carrying one and never touches the unattributed
// sweep commits, so a human's hand edit or an API write cannot be removed by
// an agent that did not make it.

export const CHANGE_SET_TRAILER = 'Mikser-Change-Set'
export const PRINCIPAL_TRAILER  = 'Mikser-Principal'
export const UNDO_TRAILER       = 'Mikser-Undo-Of'

export function changeSetTrailers(set) {
    const lines = [`${CHANGE_SET_TRAILER}: ${set.id}`]
    if (set.principal) lines.push(`${PRINCIPAL_TRAILER}: ${set.principal}`)
    if (set.undoOf)    lines.push(`${UNDO_TRAILER}: ${set.undoOf}`)
    return lines.join('\n')
}

// Parse `git log` output into change sets, newest first.
//
// One record per SET rather than per commit: a set can span several commits
// when writes arrive across cycles, and undo has to remove all of them or it
// removes half a request.
export function parseChangeSetLog(raw) {
    const sets = new Map()
    for (const block of String(raw ?? '').split('\x1e').filter(b => b.trim())) {
        const [sha, at, subject, ...bodyLines] = block.split('\x1f')
        const body = bodyLines.join('\x1f')
        const id = matchTrailer(body, CHANGE_SET_TRAILER)
        if (!id) continue
        let set = sets.get(id)
        if (!set) {
            set = {
                id,
                summary: subject?.trim() || null,
                principal: matchTrailer(body, PRINCIPAL_TRAILER),
                undoOf: matchTrailer(body, UNDO_TRAILER),
                at: Number(at) * 1000,
                commits: [],
            }
            sets.set(id, set)
        }
        // Log order is newest-first; a set's commits are recorded oldest-first
        // so a revert can walk them newest-first without re-sorting.
        set.commits.unshift(sha)
        set.at = Math.max(set.at, Number(at) * 1000)
    }
    return [...sets.values()]
}

function matchTrailer(body, name) {
    const m = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(body ?? '')
    return m ? m[1].trim() : null
}
