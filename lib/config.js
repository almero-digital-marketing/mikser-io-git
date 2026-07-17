// Resolve the factory's raw options into the fully-derived config the
// rest of the plugin uses. Pure — no filesystem, no network — so the
// validation and owner/repo/apiBase derivation are directly testable
// without instantiating the lifecycle plugin.

import { parseDuration } from './duration.js'
import { parseRepoUrl } from './repo-url.js'

const VALID_FORGES = ['github', 'gitea', 'none']

const DEFAULT_MESSAGE = ({ fileCount }) => `content: ${fileCount} file(s) via mikser`

// Accept a single path string or an array; always resolve to a
// non-empty array of strings. `paths` are pathspecs RELATIVE to the
// working folder (the repo root — see index.js) — the specific
// collections' folders (documents, layouts, files, ...) this plugin is
// allowed to touch. Everything else in the working folder
// (mikser.config.js, node_modules/, runtime/, out/, .env) is never
// staged, added, or committed by this plugin, regardless of what's
// dirty there — the pathspec is a hard scope, not a convenience.
function normalizePaths(value) {
    if (value == null) return ['documents']
    const arr = Array.isArray(value) ? value : [value]
    const cleaned = arr.map(p => String(p).trim()).filter(Boolean)
    if (cleaned.length === 0) {
        throw new Error('git: `paths` must be a non-empty string or array of strings')
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
        pollIntervalMs: parseDuration(options.pollInterval, 300_000),
        owner,
        repo,
        apiBase,
    }
}
