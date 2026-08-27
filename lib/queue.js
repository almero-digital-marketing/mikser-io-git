// One git operation at a time, per plugin instance.
//
// The sync pass and the inbound poll are independent timers — debounced
// seconds after a green cycle, and every few minutes — over the SAME
// checkout. Nothing stopped them overlapping, and git serialises through
// `index.lock`: the loser fails with "Another git process seems to be
// running", which surfaces as an intermittent sync failure that retries
// and looks like nothing. The worse shape is a commit landing while an
// inbound merge is in progress, which commits the merge rather than the
// intended change.
//
// A promise chain rather than a lock: each caller waits for the previous
// operation to settle, in order, and a rejection cannot break the chain
// because the guard already turned every body into a resolved promise.
export function createGitQueue() {
    let tail = Promise.resolve()
    return function enqueue(fn) {
        const next = tail.then(fn, fn)
        // Swallow here only — the caller's own guard reports. Without this
        // the chain itself would carry an unhandled rejection.
        tail = next.catch(() => {})
        return next
    }
}
