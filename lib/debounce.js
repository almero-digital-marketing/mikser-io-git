// Pure debounce-with-ceiling reducer for the green-gated sync timer.
//
// A green cycle should (re)start a short debounce (`after`) so a burst
// of quick edits collapses into one sync pass rather than one per
// cycle. But a pure trailing debounce never fires if green cycles keep
// arriving faster than `after` — so `maxWait` bounds how long a change
// can wait from the moment it FIRST became eligible, regardless of how
// many more green cycles follow.
//
// A red cycle clears the window outright: don't commit a state that's
// currently broken. When cycles turn green again later, that starts a
// fresh window — there's no reason to preserve how long a change was
// waiting before an interruption once the interruption has cleared.
//
// state shape: { pendingSince: number|null, fireAt: number|null }
// (both null means idle — nothing queued, no timer needed)
export function reduceDebounce(state, event, { afterMs, maxWaitMs }) {
    if (event.type === 'red') {
        return { pendingSince: null, fireAt: null }
    }
    const pendingSince = state.pendingSince ?? event.now
    const fireAt = Math.min(event.now + afterMs, pendingSince + maxWaitMs)
    return { pendingSince, fireAt }
}

export const IDLE_DEBOUNCE_STATE = { pendingSince: null, fireAt: null }
