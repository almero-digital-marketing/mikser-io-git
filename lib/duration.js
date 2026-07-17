// Parse a duration config value: a plain number of ms, or a string
// like '1m', '30s', '10m', '1h'. Same shape as other mikser-io sibling
// plugins' duration configs (e.g. mikser-io-post-email's maxDelay) —
// not shared via import (no cross-plugin imports), just a consistent
// small convention repeated where it's needed.
export function parseDuration(value, fallback) {
    if (value == null) return fallback
    if (typeof value === 'number') return value
    const m = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i.exec(String(value))
    if (!m) throw new Error(`git: invalid duration "${value}" (expected e.g. "1m", "30s", "10m", "1h")`)
    const n = Number(m[1])
    const u = m[2].toLowerCase()
    return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u])
}
