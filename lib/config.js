// Resolve the factory's raw options into the fully-derived config the
// rest of the plugin uses. Pure — no filesystem, no network — so the
// validation and owner/repo/apiBase derivation are directly testable
// without instantiating the lifecycle plugin.

import { parseDuration } from './duration.js'
import { parseRepoUrl } from './repo-url.js'

const VALID_FORGES = ['github', 'gitea', 'none']

const DEFAULT_MESSAGE = ({ fileCount }) => `content: ${fileCount} file(s) via mikser`

export function resolveConfig(options = {}) {
    if (!options.url) {
        throw new Error('git: `url` is required — the repo to sync the working folder with')
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
        folder: options.folder ?? 'documents',
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
