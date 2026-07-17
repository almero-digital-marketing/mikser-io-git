// Derive { owner, repo, apiOrigin } from a plain repo URL, so config
// only needs `url` + `forge` — not four separately-specified fields
// that would drift from the clone URL if ever changed independently.
//
// apiOrigin is the scheme+host the forge adapter's API lives at. For
// github.com this is NOT the repo's own host — GitHub's API is on
// api.github.com, a different subdomain — so github.com URLs get that
// origin by default. Self-hosted GitHub Enterprise Server serves its
// API at <host>/api/v3 instead; that's a real case this doesn't derive
// automatically — pass `apiBase` explicitly for GHES. Gitea (and any
// other self-hosted forge) serves its API at the SAME host the repo
// lives on, just under /api/v1 (which the gitea adapter appends
// itself) — so the repo's own origin is the correct default there.
export function parseRepoUrl(url) {
    let u
    try {
        u = new URL(url)
    } catch {
        throw new Error(`git: "${url}" is not a valid URL`)
    }
    const parts = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/')
    if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error(`git: cannot derive owner/repo from url "${url}" — expected .../owner/repo(.git)`)
    }
    const [owner, repo] = parts
    const apiOrigin = u.host === 'github.com' ? 'https://api.github.com' : u.origin
    return { owner, repo, apiOrigin }
}
