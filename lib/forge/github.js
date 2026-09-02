// GitHub forge adapter — create-or-reuse a PR from the write branch
// onto the target branch, and attempt to merge it.
//
// `fetchImpl` is injectable (defaults to the global fetch) purely so
// tests can supply a mock without a network or a real token.
//
// Contract shared with lib/forge/gitea.js:
//   ensurePR({...}) -> { number, url }
//   mergePR({...})  -> { merged: true } | { merged: false, reason }
// Any non-2xx response is treated as "not merged" with a best-effort
// reason string — this plugin never needs to distinguish a real merge
// conflict from a permissions error or a moved base branch; either way
// the PR stays open and a human looks at it.

function headers(token) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        // GitHub requires a User-Agent on API requests; any non-empty
        // value satisfies it.
        'User-Agent': 'mikser-io-git',
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

export async function ensurePR({ apiBase = 'https://api.github.com', owner, repo, head, base, title, token, fetchImpl = fetch }) {
    fetchImpl = bounded(fetchImpl)
    const existing = await fetchImpl(
        `${apiBase}/repos/${owner}/${repo}/pulls?head=${owner}:${head}&base=${base}&state=open`,
        { headers: headers(token) },
    )
    if (existing.ok) {
        const list = await existing.json()
        if (list.length > 0) return { number: list[0].number, url: list[0].html_url }
    }

    const created = await fetchImpl(
        `${apiBase}/repos/${owner}/${repo}/pulls`,
        { method: 'POST', headers: headers(token), body: JSON.stringify({ title, head, base }) },
    )
    if (!created.ok) {
        throw new Error(`GitHub: failed to create PR ${head} → ${base}: ${await bestEffortMessage(created)}`)
    }
    const pr = await created.json()
    return { number: pr.number, url: pr.html_url }
}

export async function mergePR({ apiBase = 'https://api.github.com', owner, repo, number, token, fetchImpl = fetch }) {
    fetchImpl = bounded(fetchImpl)
    const res = await fetchImpl(
        `${apiBase}/repos/${owner}/${repo}/pulls/${number}/merge`,
        { method: 'PUT', headers: headers(token), body: JSON.stringify({ merge_method: 'merge' }) },
    )
    if (res.ok) return { merged: true }
    const reason = await bestEffortMessage(res)
    return { merged: false, reason, transient: isTransient(res.status, reason) }
}

// The PR as the forge currently sees it. GitHub reports `mergeable: null`
// while it computes the merge commit in the background — the same window
// Gitea covers with "Please try again later", and the reason a promote that
// merges immediately after opening a PR is a race.
export async function readPR({ apiBase = 'https://api.github.com', owner, repo, number, token, fetchImpl = fetch }) {
    fetchImpl = bounded(fetchImpl)
    const res = await fetchImpl(
        `${apiBase}/repos/${owner}/${repo}/pulls/${number}`,
        { headers: headers(token) },
    )
    if (!res.ok) return null
    try {
        const pr = await res.json()
        return { mergeable: pr?.mergeable ?? null, merged: pr?.merged === true }
    } catch {
        return null
    }
}

// Does this failure mean "ask again" rather than "a human must look"?
//
// Named cases only; anything unrecognised is terminal, because a wrong guess
// that way leaves a PR for a person, while guessing transient for a real
// conflict would retry forever and bury it.
function isTransient(status, reason = '') {
    // 405 is "merge cannot be performed" — used both for a genuine conflict
    // and for a mergeability check that has not finished, so the message is
    // what separates them.
    if (/base branch was modified|try again|not ready|computing/i.test(reason)) return true
    // The head moved between the check and the merge.
    if (status === 409) return true
    return false
}
