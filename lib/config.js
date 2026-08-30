// Resolve the factory's raw options into the fully-derived config the
// rest of the plugin uses. Pure — no filesystem, no network — so the
// validation and owner/repo/apiBase derivation are directly testable
// without instantiating the lifecycle plugin.

import { parseDuration } from './duration.js'
import { parseRepoUrl } from './repo-url.js'

const VALID_FORGES = ['github', 'gitea', 'none']

const DEFAULT_MESSAGE = ({ fileCount }) => `content: ${fileCount} file(s) via mikser`

// Accept a single path string or an array; resolve to either a
// non-empty array of strings, or `null` meaning "no scope — the
// working folder itself, whatever git sees, subject to .gitignore."
// `paths`, when given, are pathspecs RELATIVE to the working folder
// (the repo root — see index.js) naming the specific collection
// folders (documents, layouts, files, ...) this plugin is allowed to
// touch: every git operation is scoped to exactly those pathspecs, so
// mikser.config.js/node_modules/runtime/out/.env are never staged or
// committed regardless of what's dirty there — a hard scope, not a
// convenience.
//
// Omitting `paths` entirely is a DIFFERENT, weaker guarantee: with no
// pathspec at all, git operates on the whole working folder, and
// `.gitignore` is the only thing keeping node_modules/.env/etc out of
// the commit — this plugin provides no scoping of its own in that
// case. The zero-config default is "the working folder is the
// checkout, commit whatever's in it" (matching the model's own
// framing), not "commit just documents/" — narrower defaults are an
// explicit `paths` away, not the unconfigured behavior.
//
// An explicitly-passed EMPTY array is treated as a mistake (throws),
// not as an alias for "no scope" — a bare `paths: []` reads as an
// oversight, not an intentional "commit everything" request, and
// silently reinterpreting it that way would hide the typo.
function normalizePaths(value) {
    if (value == null) return null
    const arr = Array.isArray(value) ? value : [value]
    const cleaned = arr.map(p => String(p).trim()).filter(Boolean)
    if (cleaned.length === 0) {
        throw new Error('git: `paths` must be a non-empty string or array of strings (omit `paths` entirely to commit the whole working folder)')
    }
    return cleaned
}

export function resolveConfig(options = {}) {
    if (!options.url) {
        throw new Error('git: `url` is required — the repo the working folder syncs with')
    }
    const forge = options.forge ?? 'none'
    if (!VALID_FORGES.includes(forge)) {
        throw new Error(`git: \`forge\` must be "github", "gitea", or "none"; got ${JSON.stringify(forge)}`)
    }

    let owner = options.owner
    let repo = options.repo
    let apiBase = options.apiBase
    if (forge !== 'none' && (!owner || !repo || !apiBase)) {
        const parsed = parseRepoUrl(options.url)
        owner   = owner   ?? parsed.owner
        repo    = repo    ?? parsed.repo
        apiBase = apiBase ?? parsed.apiOrigin
    }

    return {
        url: options.url,
        paths: normalizePaths(options.paths),
        forge,
        targetBranch: options.branch ?? 'main',
        writeBranch: options.writeBranch ?? 'mikser',
        token: options.token,
        message: options.message ?? DEFAULT_MESSAGE,
        author: options.author,
        afterMs: parseDuration(options.after, 60_000),
        maxWaitMs: parseDuration(options.maxWait, 600_000),
        // How long an OPEN change set may go quiet before it is committed
        // anyway. Separate from `after`, which batches human editing: a minute
        // of quiet is right for someone typing in WebDAV and far too long for
        // an agent that wants to reason about what it just did. A set the
        // writer closed does not wait at all.
        changeSetAfterMs: parseDuration(options.changeSetAfter, 3_000),
        pollIntervalMs: parseDuration(options.pollInterval, 300_000),
        owner,
        repo,
        apiBase,
    }
}
