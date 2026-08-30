// Gitea forge adapter. Gitea's API is deliberately modeled on GitHub's
// for pull requests, but with real differences confirmed against
// Gitea's own route definitions (routers/api/v1/api.go):
//   - base path is <instance-url>/api/v1, not a fixed host
//   - auth header is `Authorization: token <token>` (Gitea's documented
//     scheme), not `Bearer`
//   - merge is POST .../pulls/{index}/merge with body `{ Do: 'merge' }`
//     (GitHub: PUT .../merge with `{ merge_method }`) — there is NO
//     bare "merge branch A into B" endpoint; merge-upstream exists but
//     is a different feature (syncing a fork from its upstream), so
//     the pull-request path is the only portable one.
// The head/base ref field names on a listed PR (`head.ref` / `base.ref`)
// are assumed to mirror GitHub's shape (Gitea's PullRequest struct is
// modeled the same way) but are NOT independently verified here — if
// they don't match, ensurePR's existing-PR lookup simply finds nothing
// and creates a new PR. Worst case is a duplicate open PR, never lost
// content, so this is a safe direction to be wrong in.
//
// Same contract as lib/forge/github.js:
//   ensurePR({...}) -> { number, url }
//   mergePR({...})  -> { merged: true } | { merged: false, reason }

function headers(token) {
    return {
        'Authorization': `token ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }
}

async function bestEffortMessage(res) {
    try {
        const body = await res.json()
        return body?.message ?? res.statusText
    } catch {
        return res.statusText
    }
}

// A forge call that never answers blocks the whole git queue behind it, so
// every request is bounded. AbortSignal.timeout rejects the fetch, which the
// promote path already treats as "could not promote" and retries next pass.
const FORGE_TIMEOUT_MS = 30_000
const bounded = (fetchImpl) => (url, init = {}) =>
    fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(FORGE_TIMEOUT_MS) })

export async function ensurePR({ apiBase, owner, repo, head, base, title, token, fetchImpl = fetch }) {
    fetchImpl = bounded(fetchImpl)
    const listRes = await fetchImpl(
        `${apiBase}/api/v1/repos/${owner}/${repo}/pulls?state=open`,
        { headers: headers(token) },
    )
    if (listRes.ok) {
        const list = await listRes.json()
        const match = Array.isArray(list)
            ? list.find(pr => pr.head?.ref === head && pr.base?.ref === base)
            : null
        if (match) return { number: match.number, url: match.html_url ?? match.url }
    }

    const created = await fetchImpl(
        `${apiBase}/api/v1/repos/${owner}/${repo}/pulls`,
        { method: 'POST', headers: headers(token), body: JSON.stringify({ title, head, base }) },
    )
    if (!created.ok) {
        throw new Error(`Gitea: failed to create PR ${head} → ${base}: ${await bestEffortMessage(created)}`)
    }
    const pr = await created.json()
    return { number: pr.number, url: pr.html_url ?? pr.url }
}

export async function mergePR({ apiBase, owner, repo, number, token, fetchImpl = fetch }) {
    fetchImpl = bounded(fetchImpl)
    const res = await fetchImpl(
        `${apiBase}/api/v1/repos/${owner}/${repo}/pulls/${number}/merge`,
        { method: 'POST', headers: headers(token), body: JSON.stringify({ Do: 'merge' }) },
    )
    if (res.ok) return { merged: true }
    return { merged: false, reason: await bestEffortMessage(res) }
}
