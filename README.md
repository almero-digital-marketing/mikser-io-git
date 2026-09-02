# mikser-io-git

Two-way git sync for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). The **working folder itself is the checkout** — one repo, one dedicated write branch, shared across however many of its collections (`documents`, `layouts`, `files`, ...) you want auto-committed. Every green cycle (no render/postprocess failure) commits and pushes whatever changed inside those folders to that branch — the durable log of every API/MCP/agent edit — then tries to promote it into your target branch via a pull request. A red cycle holds the promotion; a merge conflict just leaves the PR open. Nothing is ever silently lost, and nothing broken ever reaches your default branch on its own.

Forge-portable: GitHub and Gitea adapters ship together, plus a no-forge fast-forward-only floor that works against any bare remote.

## Why this exists

mikser's API and MCP endpoints can write to **any registered collection**, not just documents — `PUT .../entities` and the MCP update/delete tools take `collection` as a plain field on the request, and `useCollection(runtime, collection).write(...)` resolves the folder generically via `runtime.options[`${collection}Folder`]`. So an agent editing a layout template goes through the exact same code as an agent editing a blog post. Those writes are ordinary file changes; the engine's file watcher picks them up like any local edit. Nothing in mikser records *who* changed a file — by design, files-as-source-of-truth doesn't care who wrote to them. So there's no way to distinguish an agent's edit from a human's after the fact, and this plugin doesn't try to. It versions **everything that changed and didn't break anything**, in whichever collections you tell it to watch, regardless of where the write came from.

## The model

```
   API / MCP / agent writes to           human, via a PR review
   documents/, layouts/, ... directly              ▲
        │                                          │
        ▼                                          │
  <working folder>  (the checkout itself, on the "mikser" branch)
   ├── documents/     ◀── in `paths`, auto-committed
   ├── layouts/       ◀── in `paths`, auto-committed
   ├── mikser.config.js, node_modules/, runtime/, out/, .env
   │                  ◀── NOT in `paths` — never touched, ever
        │
        │  every green cycle: commit + push, scoped to `paths` (always — durability)
        ▼
   origin/mikser  ── PR / fast-forward ──▶  origin/main
        ▲                                        │
        │                                        │
        └──────────── poll: pull inbound ─────────┘
```

- **The working folder is the checkout.** One `git()` instance manages one repo, one write branch — not a separate nested checkout per collection. Multiple collections (`paths: ['documents', 'layouts']`) share the same commit, the same branch, the same promotion. This also means you don't need a separate repo (or even a separate branch name) per collection the way managing each folder as its own independent checkout would — that shape existed in an earlier version of this plugin and needed real care to avoid two unrelated checkouts fighting over one branch ref; sharing one checkout removes the problem outright.
- **`paths`, when set, is a hard scope, not a convenience.** Every git operation (`status`, `add`, `commit`) is pathspec-scoped to exactly the folders you list. `mikser.config.js`, `node_modules/`, `runtime/`, `out/`, `.env` can sit in the exact same checkout and are never staged, added, or committed by this plugin — regardless of whether they're dirty, regardless of `.gitignore`. Verified directly against a real repo (see [Verified end-to-end](#verified-end-to-end)): an edit to `mikser.config.js` alone produces zero commits; an edit inside a `paths` folder commits normally, and only the files inside `paths` show up in that commit. **Omit `paths` and there's no scope at all** — the whole working folder is fair game, and `.gitignore` becomes the only thing keeping the noise out. See [Configure](#configure) for the trade-off.
- **`mikser` branch** — this plugin's own branch. It commits and pushes here on *every* green cycle, unconditionally. A red cycle never blocks this — the write branch is the durable log; it must never lose work to a later failure.
- **`main` (or whatever you name your target)** — promoted to only when the cycle that produced the change was green. Promotion is a pull request (GitHub/Gitea) that gets merged automatically on success, or a direct fast-forward push (`forge: 'none'`). A conflict just leaves the PR open — a human resolves it in the forge's own UI, in their own time. This plugin never picks a winner.
- **Inbound** — remote changes (a human pushed to `main`, or someone pushed directly to `mikser`) are pulled in on a timer and merged into the local working copy. Since `git merge` writes real files, mikser's own file watcher sees them exactly like a local edit — no special wake-up code needed.

**This is meant for a deployment target this plugin (and mikser) exclusively manages — not a developer's actively-edited local checkout.** Bootstrap checks out and holds the write branch for the ENTIRE working folder, not just the collections in `paths`. Point this at a developer's own local clone of the project and it will switch their currently-checked-out branch out from under them — same risk that existed before, just now at the scope of the whole project directory instead of one subfolder. A server deployment where nobody manually runs `git` in that checkout is the intended shape.

## When a change is committed

Two clocks, because two kinds of writer need different ones.

| | waits for |
| --- | --- |
| a change set the writer **closed** | nothing — committed on the next cycle |
| a change set still **open** | `changeSetAfter` of quiet (default 3s) |
| everything else (WebDAV, hand edits, API) | `after` of quiet (default 60s) |

`after` exists to batch a human typing: commit once they stop, not once per
keystroke. An agent's request is already batched — the change set IS the batch
— so holding it for another minute only delays the moment it can be undone,
and leaves the id it was handed unusable in the meantime.

A set closes when the writer says it is finished. An id minted for a single
tool call closes when that call returns, which is exact rather than a guess: an
id nobody else can name cannot grow afterwards. An id the CALLER supplied is
the opposite — it exists so several calls can join one set — so it waits out
`changeSetAfter` instead, and a request spanning several calls still commits as
one commit and undoes as one undo.

## Undo (MCP only)

An agent's request is one **change set**: however many files it wrote, committed
together, stamped with a `Mikser-Change-Set` trailer and the agent's own summary
as the subject. `mikser_changes` lists them; `mikser_undo` takes one back.

```
mikser_changes                     → recent change sets, newest first
mikser_undo({ id, dryRun: true })  → what it would do, touching nothing
mikser_undo({ id, dryRun: false }) → apply it
```

**Only agent writes are undoable.** API writes and human edits are committed
too — the durable log never drops anything — but into unattributed sweep
commits with no trailer, and the trailer is the permission boundary. Those
callers have git; an undo they could reach would be an undo able to remove work
it never made.

**It removes a contribution, it does not restore a snapshot.** Documents added
through the API since, and edits made by hand, are kept. The undo lands as an
ordinary forward commit, so history is never rewritten, the deploy branch is
never force-pushed, and the undo is itself an undoable change set.

Two independent things stop an undo, and they need different answers:

| | means |
| --- | --- |
| `conflict` | a later change edited the same content — it cannot be applied automatically, and no `force` overrides it |
| `dangling` | something added since references what this undo would REMOVE |

The second is the dangerous one. Git applies it perfectly cleanly and the site
breaks anyway, because the new document points at a layout that no longer
exists — so the check runs against the engine's reference index rather than
against the patch. `force: true` proceeds regardless; nothing bypasses a
conflict.

A dry run and a refusal never touch the working folder. The patch is tested
with `git apply --check` against a copy in the system temp dir, because a
half-applied revert in a deployed checkout means the build stops — an undo that
takes the site down is worse than the change it was undoing.

### Why the commit scope matters

Staging by folder is what the durable-log sweep does, and it is wrong for a
change set. If an agent edits one document while a second is created through
the API a moment later, a folder-scoped `git add` puts both in the agent's
commit — and undoing the agent then deletes the API's document. Change-set
commits stage exactly the paths that set wrote, so the commit's contents match
its label.

Requires the `mcp` plugin. Without it the tools are not registered and the
plugin behaves exactly as before.

## Install

```bash
npm install mikser-io-git
```

## Configure

```js
import { git } from 'mikser-io-git'

export default {
    plugins: [
        git({
            url:    'https://github.com/your-org/your-content.git',
            paths:  ['documents'],         // scope auto-commits to just this folder
            forge:  'github',              // 'github' | 'gitea' | 'none' (default 'none')
            token:  process.env.GITHUB_TOKEN,
        }),
        // ...your other plugins
    ],
}
```

Versioning more than one collection (they'll share the same commit, the same branch, the same promotion — no extra config needed per folder):

```js
git({
    url:   'https://github.com/your-org/your-content.git',
    paths: ['documents', 'layouts', 'files'],
    forge: 'github',
    token: process.env.GITHUB_TOKEN,
})
```

**Omitting `paths` entirely** commits the whole working folder — no scoping at all:

```js
git({ url: 'https://github.com/your-org/your-content.git', forge: 'github', token: process.env.GITHUB_TOKEN })
// no `paths` — everything under the working folder is fair game, subject to .gitignore
```

This is the honest zero-config default, matching how the plugin actually works ("the working folder is the checkout") rather than silently narrowing to one collection nobody asked for. But **it's a weaker guarantee than `paths`**: when you list specific paths, they're a hard pathspec scope — `mikser.config.js`/`node_modules/`/`.env` are never touched, full stop, regardless of `.gitignore`. Omit `paths` and there's no pathspec at all; **`.gitignore` becomes the only thing standing between `node_modules/`, `.env`, `runtime/`, `out/` and your content repo.** Give the working folder a normal `.gitignore` if you're relying on the default — this plugin doesn't add one for you, and doesn't need to: `git add -A` already respects whatever's there. If you'd rather not depend on remembering that, list `paths` explicitly and get the hard scope instead.

### Gitea

```js
git({
    url:   'https://git.almero.bg/your-org/your-content.git',
    forge: 'gitea',
    token: process.env.GITEA_TOKEN,
})
```

`owner`, `repo`, and the forge API's base URL are all derived from `url` — you don't repeat them. Override any of them explicitly (`owner`, `repo`, `apiBase`) if your setup needs it — e.g. GitHub Enterprise Server, whose API lives at `<host>/api/v3` rather than `api.github.com`.

### No forge (any bare remote, self-hosted or otherwise)

```js
git({ url: 'https://git.internal.example/content.git', forge: 'none' })
```

Promotion becomes a direct `git push mikser:main` (fast-forward only). No API calls, no token scopes beyond git's own auth — works against literally any remote a `git push` would work against. If `main` has diverged (someone pushed to it directly since the last promotion), the push is rejected; everything stays queued on `mikser` until you configure a forge adapter or merge by hand.

## Options reference

```js
git({
    url:            'https://github.com/org/repo.git',  // REQUIRED
    paths:          undefined,        // string or array — collection folder(s) to auto-commit,
                                       // relative to the working folder. Default: unset, meaning
                                       // the WHOLE working folder (subject to .gitignore) — see
                                       // "Omitting paths entirely" above for the trade-off.
    forge:          'none',           // 'github' | 'gitea' | 'none'
    branch:         'main',           // target branch — promoted to only when green
    writeBranch:    'mikser',         // this plugin's own durable branch
    token:          undefined,        // auth token. Omit to fall back to git's own credential
                                       // resolution (SSH agent, credential helper, deploy key)
    owner:          undefined,        // derived from `url` when forge != 'none'
    repo:           undefined,        // derived from `url` when forge != 'none'
    apiBase:        undefined,        // derived from `url`; override for GHES etc.
    after:          '1m',             // debounce after a green cycle before syncing
    maxWait:        '10m',            // ceiling — sync fires by this deadline even under
                                       // a steady stream of green cycles that keep resetting `after`
    pollInterval:   '5m',             // how often to check the remote for inbound changes
    message:        ({ fileCount }) => `content: ${fileCount} file(s) via mikser`,
    author:         { name: 'mikser', email: 'bot@yourdomain.com' },
})
```

## First connect — and why it can refuse to guess

The checkout root is **the working folder itself** — the same directory `mikser.config.js` lives in. The one genuinely destructive moment in this plugin is attaching git to that folder for the first time. If it already has files but isn't a checkout, there is no safe default: "local wins" silently discards whatever's already in the remote repo the first time it syncs; "remote wins" silently discards your existing files. Whichever you didn't pick is gone on the next push or pull — there's no undo.

So the plugin does the only honest thing: **it refuses**, and tells you exactly what it found:

```
git: Working folder exists, has files, and is not a git repository. Refusing to guess whether
local files or the remote should win — whichever loses gets silently overwritten on the next
sync. Attach it by hand ONCE, from the working folder itself (this does not touch your files,
only history):
    git init
    git remote add origin https://github.com/org/repo.git
    git fetch origin
    git reset --mixed origin/main
Then run `git status` — anything it reports as an untracked/modified file is the real
divergence to resolve by hand before the plugin takes over.
```

That recipe attaches git history to the folder without touching a single file — `reset --mixed` only moves what HEAD and the index point at, never the working tree. `git status` afterward tells you the true story: files present locally but not in the remote show as untracked; files different between the two show as modified. You only need to actually resolve the divergence in the folders you listed in `paths` — everything else (`mikser.config.js`, `node_modules/`, `.env`, ...) can sit there showing as untracked forever; this plugin never touches it, so it never needs reconciling. After the one-time attach, the folder is an ordinary checkout and this code path never runs again.

**In practice this is now the common first-run path, not the rare one.** Because the checkout root is the whole working folder, and a working folder almost always already has `mikser.config.js`, `node_modules/`, etc. in it by the time this plugin loads, the "clone into an empty folder" case barely comes up — it's really only for a bare, freshly-provisioned directory that hasn't even been given a config yet. Every real project you point this at will hit `refuse` on its very first connect, and that's by design: the one-time manual step is where a human with actual context makes the one decision this plugin can't make safely.

If the folder is already a checkout of the configured repo, bootstrap just verifies and moves on, every restart, at no cost — the common case after the first connect.

Add a `.gitignore` in that same folder regardless of whether you set `paths` — it keeps `git status` itself readable for a human poking around either way. But its role differs by config: with `paths` set, the pathspec is the real enforcement and `.gitignore` is just hygiene on top; with `paths` omitted, `.gitignore` **is** the enforcement — there's no pathspec backing it up in that case. Use:

```gitignore
node_modules
runtime/
out/
.env
```

**Note the missing trailing slash on `node_modules`** — deliberately, not an oversight. A trailing-slash pattern (`node_modules/`) means "directories only" in git's own matching rules, and a *symlinked* `node_modules` (common under npm/pnpm/yarn workspaces) is not a directory by that definition even though it points at one — `node_modules/` silently fails to ignore it, `node_modules` (no slash) matches either shape. Confirmed directly: `git check-ignore -v node_modules` reported "not ignored" against a symlink with the trailing-slash form, and a live no-`paths` test genuinely leaked a workspace-symlinked `node_modules` into a real commit before this was caught. This is exactly the class of subtle miss that makes `paths` the stronger guarantee over `.gitignore` alone — the pathspec doesn't care what shape the excluded thing is.

## What counts as "green"

A cycle is green when no render or postprocess produced a failure (`output.success === false` on the journal entry — the same signal mikser's own manifest uses to decide whether to record a snapshot). It is **not** a correctness or schema check:

- A `warn`-mode schema violation still renders successfully — it commits. Warnings are deliberately not errors (see mikser's own `warnings-not-errors` posture); this plugin follows the same line.
- An entity with no matching layout produces no render task at all, hence no failure signal — it commits.
- A validation rejection in `fail` mode means the entity never entered the catalog in the first place (mikser's `runtime.validate` gates `createEntity`/`updateEntity` before the journal), so there's nothing on disk to commit for it either way.

The guarantee this plugin actually gives you is narrower and more honest than "only correct content ships": **nothing that failed to render or postprocess is ever committed.** A held-back change isn't lost — it's still sitting on disk, and it commits the moment a later cycle turns green, along with everything else that accumulated in the meantime. If your content graph has cross-references (a broken author page can break every post that references it), a single stale failure can hold back everything indefinitely — which is the intended behavior, not a bug: the plugin has no way to tell "the thing that broke" from "the thing that happens to be blocked by it," so it holds the whole batch until the build is clean again, and logs loudly the entire time it's held.

## Promotion mechanics

**GitHub / Gitea**: one open pull request from `writeBranch` into `branch`, reused across cycles (never spammed) — the plugin looks for an existing open PR with the right head/base before creating a new one. On a green cycle it asks the forge whether the PR is mergeable, then merges it. Success: the write branch is fast-forwarded (well, hard-reset) onto the new target tip and re-pushed, so it never drifts arbitrarily far from `main` between promotions.

Failure is split in two, because the forge means two different things by it:

- **A human has to look** — a conflict, a protected branch, a required review. The PR stays open, nothing is discarded, and a warning names the reason and links the PR, re-logged at most every 30 minutes.
- **Not ready yet** — the forge has not finished computing mergeability (`mergeable: null`, Gitea's *"Please try again later"*), or the head moved under the merge. That is a retry signal, not a verdict, and it is answered by retrying rather than by giving up.

**The retry runs on the inbound poll, not on the next commit.** The condition is "the write branch is ahead of the target", which stays true after the editor has finished editing — coupling it to "we just committed" meant a transient failure was terminal in practice, because the retry needed an edit that was never coming. An outstanding promote lands on its own within one poll interval.

**A write branch that stays ahead is an error, not a warning.** Past a few minutes this is a broken pipeline rather than a slow one, and it is the one condition where the site and the repository disagree about what the site is: the container that took the edit serves it from its working folder, while a rebuild from the target branch comes up without it and the next push to the target reverts it — as a valid commit, on a green build. It is logged at error level with the code `git-promote-stuck`, naming both refs, so it surfaces as a fault in `--json` and `mikser_ping` rather than only in a log.

**`forge: 'none'`**: `git push mikser:main`, fast-forward only. No PR, no API. If it's rejected (main has diverged), the same holding behavior applies — everything queues on `mikser`, logged, until you merge by hand or switch on a forge adapter.

## Inbound sync

On a poll timer (default every 5 minutes, watch mode only — a one-shot build has no "later" to pull into), the plugin fetches and merges `origin/<writeBranch>` then `origin/<branch>` into the local working copy, in that order — note this fetch+merge is NOT scoped to `paths` (a merge operates on whole commits; there's no such thing as "merge just some files"). `git merge` writes files via ordinary filesystem writes, so mikser's own file watcher (chokidar, already watching whichever collection folders their own source plugins registered) sees the change exactly like a human editing a file — no explicit wake-up call needed. A merge could in principle also touch something outside `paths` (say, `main` gained a `mikser.config.js` change from a developer) — mikser doesn't hot-reload its own config, so that lands on disk but has no effect until the process restarts; nothing this plugin needs to solve.

**On any merge conflict, the merge is aborted immediately** — the working folder is mikser's live render source; leaving conflict-marker text (`<<<<<<< HEAD`) in a file would mean that text gets rendered as page content on the very next cycle. A conflict is logged with the branch it came from and the raw git error; resolve it by hand in the folder, the same way you'd resolve any git conflict.

**Webhook delivery is not implemented.** Polling is the only supported inbound trigger in this version. A webhook would mean verifying HMAC signatures correctly for two different forges (`X-Hub-Signature-256` for GitHub, a different scheme for Gitea) without a live instance of either to test against while building this — shipping that unverified would be a worse trade than an honest 5-minute default poll interval. If you need faster inbound turnaround, lower `pollInterval`; a real webhook is a plausible follow-up once it can be tested against a live forge.

## Why not the GitHub `/merges` / Gitea `merge-upstream` endpoints?

Both forges have *some* direct-merge concept, but they're not the same feature and not portable: GitHub's `/repos/:owner/:repo/merges` merges one branch into another with no review step; Gitea's `/repos/:owner/:repo/merge-upstream` syncs a fork from its own upstream — a different operation entirely, not a general branch merge. Building a "direct merge" abstraction over both would mean papering over a real semantic mismatch between forges.

Pull requests, by contrast, are nearly identical between the two — `POST .../pulls { title, head, base }` creates one on both GitHub and Gitea. And a PR gives you something the direct-merge endpoints don't: a real conflict surface. A `/merges` 409 is a status code with nowhere to look; a conflicted PR is a page that names the exact files in conflict and offers to resolve them in the forge's own UI. That's a better fit for "leave it open, let a human resolve it" than either forge's direct-merge shortcut.

## Requirements

- **git 2.31 or newer** on the machine running mikser. The auth token is
  delivered to git through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
  `GIT_CONFIG_VALUE_n`, which older git ignores — it would fall back to
  unauthenticated access and fail against a private repo. 2.31 shipped in
  March 2021; `git --version` if unsure.
- No runtime npm dependencies. Everything goes through the `git` binary.

## Security

- **The auth token is never written to disk, and never appears in the process's arguments.** It's passed as a one-off `http.extraheader` for the specific git command that needs it (`clone`/`fetch`/`push`/`ls-remote`), delivered through the environment (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, git 2.31+) rather than as a `-c` argument, and never embedded in the remote URL.

  Three places a credential can leak, and what each avoids: an embedded `https://token@host/...` remote persists into `.git/config` in plaintext and shows up in `git remote -v` and any log line echoing the remote; a `-c http.extraheader=...` argument lands in the process's argument list, which is world-readable on Linux (`/proc/<pid>/cmdline` is `-r--r--r--`, while `/proc/<pid>/environ` is `-r--------`) and can surface in an `err.stderr` a caller then logs; the environment form has neither property and the same one-command lifetime. Note that base64 here is encoding, not encryption — it is the HTTP Basic wire format, so keeping it out of world-readable places is the whole protection.
- **Every git invocation goes through `execFile` with an argv array — never a shell string.** Commit messages are built from a file count, not raw content, but nothing here ever risks passing arbitrary content through a shell regardless.
- **A timer body can never end the process.** Both schedulers here — the debounced sync pass and the inbound poll — run for the life of a watch server, and Node has treated an unhandled rejection as fatal since v15 while mikser installs no process-level handler. `pullInbound` returns a result shape for every outcome including a failed `fetch`, and both callbacks are wrapped besides: a transient remote failure must not take down the build and the site, least of all in a supervisor restart loop.
- **Git operations are serialised per instance.** The sync pass and the inbound poll share one checkout; without a queue they overlap and lose to `index.lock`, or worse, commit while an inbound merge is in progress.
- **The write branch is force-pushed only after a successful promotion**, using `--force-with-lease` (refuses if the remote moved unexpectedly since the last fetch) rather than a bare `--force`. This is safe specifically because `mikser`/`writeBranch` is a branch this plugin owns exclusively — nothing else's history is ever at risk on it.

## Verified end-to-end

The unit suite (73 tests) covers every pure module directly, the forge adapters via an injected `fetchImpl` mock, and — critically for the working-folder-as-checkout model — the pathspec scope itself against a real temp git repo (`test/git.test.js`'s "pathspec scoping" suite: a config-file edit and a whole new out-of-scope directory are both proven invisible to a `paths`-scoped add, while an in-scope file commits normally). Beyond the unit suite, this has been run against **real GitHub repos and mikser's own example blog** — not just mocks:

- **The "adopt an existing non-empty folder" recipe** (see [First connect](#first-connect--and-why-it-can-refuse-to-guess)), run by hand exactly as documented, against the real blog's working folder — `mikser.config.js`, `node_modules/`, `layouts/`, `documents/`, everything — and a fresh throwaway GitHub repo. `refuse` fired correctly on the very first connect attempt (confirming that's now the expected first-run path, not an edge case); the manual recipe attached history without touching a file; `git status` afterward showed exactly the expected divergence.
- **The `paths` scope boundary, live, not just unit-tested.** With `paths: ['documents', 'layouts']` on that same checkout: a build with only a `mikser.config.js`/`LICENSE` edit produced **zero commits** — no `git: committed + pushed` line at all; a build with a real `layouts/` edit committed, pushed, and promoted normally. A fresh clone of the repo afterward showed the tree contained **only** `documents/`, `layouts/`, and the seed file — no `mikser.config.js`, no `node_modules`, nothing leaked from outside `paths`.
- **The full real render pipeline** — the actual `mikser-io-example-blog` config: 13 lifecycle plugins, real layouts, a real CSV fetch from a live Google Sheet, real OpenAI vector embeddings, 30 renders, zero warnings or failures. A genuinely green cycle, not an empty test harness.
- **Real GitHub pull requests, created and merged by the actual API** — not a mocked response, across two separate throwaway repos (one per major design iteration). Multiple full sync cycles each produced their own PR (`Promote mikser → main`), all auto-merged; `gh api` confirmed `main` and `mikser` converged on the identical commit SHA after each merge, and repeated cycles proved the "reuse an open PR, don't spam a new one" / "open a fresh PR once the last one closed" logic works correctly across repeated promotions — including with multiple collections landing in the same commit.
- **One real bug found and fixed this way** (v1.0.1): `git status --porcelain` collapses a brand-new untracked directory into a single line instead of one per file, so the commit message's file count silently undercounted whenever a change arrived as a new directory (a new author's folder, a new content category). Confirmed directly — a real 2-file new directory produced `"content: 1 file(s)"` before the fix — and fixed with `--untracked-files=all`. `git add -A` itself was never affected; only the message text was wrong.
- **The zero-config default (`paths` omitted), live.** The same checkout, reconfigured with no `paths` at all, correctly committed the whole working folder — `mikser.config.js`, `package.json`, `authors.csv`, everything not gitignored — on the very next sync, exactly matching the documented behavior. It also surfaced a real, honest-to-document gotcha: the scratch test's `node_modules` was a workspace symlink, and `.gitignore`'s trailing-slash `node_modules/` pattern does **not** match a symlink even when it points at a real directory (confirmed with `git check-ignore -v`) — so it leaked into that commit. Not a plugin bug (`git add -A` correctly respected `.gitignore`'s actual, documented semantics); the README's recommended `.gitignore` now drops the trailing slash for exactly this reason, and this is precisely the class of miss `paths` (a hard pathspec, indifferent to symlink-vs-directory) doesn't have.

**What this has NOT been run against**, stated plainly rather than assumed: a genuine render/postprocess *failure* mid-flow (the red-cycle hold-back path is covered by the debounce reducer's unit tests and direct tracing against mikser's `output.success` signal, not a live failing build), Gitea (the adapter is unit-tested against mocked responses shaped from Gitea's own route source, not a live instance), and a real merge *conflict* (every live test cycle was a clean fast-forward on the forge side — no divergent `main` to force a genuine PR conflict).

## What this plugin does NOT do

- **Resolve conflicts.** Ever. A promotion conflict leaves an open PR; an inbound conflict aborts and logs. A human resolves both, always.
- **Distinguish API/MCP writes from human edits.** It can't — by the time a write reaches the journal, it's an ordinary file change indistinguishable from a local save, and this holds for any collection you list in `paths`, not just documents. Disable this plugin in your dev config if you don't want your own WIP edits auto-committed; it's designed to be enabled only where every write to the paths you configured is already programmatic (a deployed CMS instance), not where a human is also editing files directly.
- **Webhook-triggered inbound sync.** See above — polling only, for now.
- **Validate content quality.** "Green" means "rendered without failing," not "correct." Schema warnings, missing-layout entities, and anything else that doesn't produce a render/postprocess failure all commit normally.
- **Squash or rebase history.** Every promotion is a plain merge (or fast-forward); the write branch's commit history is preserved as-is in the merge commit's ancestry.

## License

MIT
