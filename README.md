# Overleaf Snapshot to GitHub

A Chrome Extension (Manifest V3) that commits Overleaf project snapshots to a GitHub repository — without needing **Overleaf Premium**, Overleaf's Git integration, or the Overleaf GitHub sync feature.

> **This extension does not provide guaranteed bidirectional Overleaf↔GitHub Git sync.** It creates GitHub commits from Overleaf source ZIP snapshots. An experimental live-sync section is gated behind opt-in settings and clearly labelled as such.

## What this extension does

It commits Overleaf project snapshots to GitHub.

The stable workflow is:

```
Open Overleaf project tab
   →  Click extension icon
   →  "Fetch from current Overleaf project"   (automatic ZIP route)
   →  Diff against your GitHub branch
   →  Review preview
   →  Commit
```

If the automatic ZIP route fails, you can fall back to **Manual ZIP upload**: download the source ZIP from Overleaf's **Menu → Source** and select it in the popup.

There is also an opt-in **Experimental Overleaf Live Sync** section in the options page. It is disabled by default and clearly marked experimental.

## Modes

### A. Stable mode — automatic Overleaf ZIP snapshot

- Uses the **current browser session**: when you have an Overleaf project tab open and you are signed in, the extension fetches the project's source ZIP for you and runs the same diff/commit pipeline as the manual flow.
- Requires the user to be logged into Overleaf in the browser. The browser attaches the existing session cookie to the request via `credentials: "include"` — the extension itself **never reads, stores, displays, or logs the Overleaf cookie**.
- Does **not** require Overleaf Premium, the Git Bridge, or the GitHub integration.
- Does **not** ask for or use the `chrome.cookies` permission.
- Does **not** scrape Overleaf private credentials.
- Tries two known Overleaf ZIP endpoints in order; on 404 it falls back to the next, on any other failure it surfaces a typed error with a clear recovery action.

### B. Fallback mode — manual ZIP upload

The original MVP behavior remains as a fallback:

- Download the Overleaf **Source** ZIP from **Menu → Source** in Overleaf.
- Open the extension popup.
- Pick the ZIP — the popup runs the same diff/commit flow.

Manual ZIP upload is **always available**, even if automatic fetch fails. The error UI keeps the ZIP picker visible so you can recover in one click.

### C. Experimental — Overleaf Live Sync (off by default)

The options page contains an **Experimental Overleaf Live Sync** section, fully disabled by default. The status of each capability as of this release:

- **Live read-only pull** *(probe only)* — the popup button exists and reaches the Overleaf real-time handshake, but the document channel itself is a stub: any project containing text documents will fail with `protocol_unavailable` and the popup falls back to ZIP. Useful for confirming the handshake works on your build; not yet useful for fetching real content. A working document channel is slated for a future release.
- **Explicit Overleaf write-back** *(module only — no UI)* — the code path (`writeSelectedFilesBackToOverleaf`, conflict detector, OT helper, backup gate, typed confirmation contract) is implemented and exported, but there is no popup or options UI that calls it in this build. Toggling the option has no visible effect yet. When the live channel lands, this is the next surface to wire up.
- **Local replica prototype** *(module only — no UI)* — `localReplicaManager`, `localFolderAccess`, and the three-way `localConflictDetector` are implemented, but there is no UI that picks a folder, compares, or pulls. The File System Access API requirement is real for when the UI lands. See "Local replica prototype" below for the planned shape.

Each experimental capability still has its own settings toggle, so future revisions can wire the UI without changing storage. Settings include:

- Require ZIP backup before write-back (default ON)
- Require typed confirmation before write-back (default ON)
- Allow binary file write-back (default OFF)
- Allowed write-back extensions (default `.tex`, `.bib`, `.cls`, `.sty`, `.bst`, `.md`, `.txt`)

> **Important.** Experimental live sync depends on Overleaf internals that may break without warning. The stable ZIP route is always available as a fallback. Even when the live read-only pull only fetches a partial snapshot, the popup blocks deletion-style commits until warnings clear, so partial fetches cannot silently remove files from your GitHub branch.

## Local replica prototype (modules only — no UI yet)

> **Status:** the modules described below ship in `src/localReplica/` and are reachable from code, but **no UI in this build calls them**. The feature toggle in options has no visible effect yet. This section describes the planned shape; it is not yet user-runnable. When the UI lands, it will live on the options page or a dedicated section of the popup.

The local replica feature requires the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) (Chrome, Edge, Opera). When the API is missing the feature will stay disabled and the UI will show: *Local replica requires File System Access API or a native helper.*

Planned capabilities:

- Choose a local folder.
- Compare Overleaf ↔ Local with explicit `unchanged / local_modified / overleaf_modified / both_modified_conflict / local_only / overleaf_only / deleted_local / deleted_overleaf` statuses.
- Pull Overleaf snapshot to local folder (only after preview).
- Write selected local files back to Overleaf (only after explicit confirmation, conflict check, and backup).
- Commit local snapshot to GitHub via the normal commit pipeline.

Even once wired, there will be **no** automatic background sync, **no** filesystem watcher, **no** silent overwrite, and **no** automatic conflict resolution.

## Security

The extension was designed with the following guarantees:

- **No Overleaf cookie copying.** The extension never reads `document.cookie`, never requests the `chrome.cookies` permission, and never stores or transmits an Overleaf cookie. All Overleaf requests use `credentials: "include"` so the browser attaches its own session cookies — the extension code does not see them.
- **No raw Overleaf credentials.** The extension does not ask for an Overleaf password, API token, or session string. There is no Overleaf login UI inside the extension.
- **GitHub token isolation.** The GitHub PAT is stored only in `chrome.storage.local`. It is only sent to `api.github.com`. The content script never receives it.
- **Narrow host permissions.** `https://www.overleaf.com/*` and `https://api.github.com/*` only.
- **No force push, ever.** The Git ref update always sends `force: false`. If the branch moved between preview and commit, the commit aborts cleanly.
- **No destructive automatic sync.** All write-back actions, local-replica pulls, and Overleaf writes require explicit user gestures.
- **Strict conflict detection.** Write-back refuses to overwrite a file whose remote SHA differs from the user's base snapshot.
- **Versioning gating.** If safe Overleaf document versioning cannot be confirmed, write-back returns `write_back_not_safe` instead of attempting a blind replace.

## Limitations

- **Not true Git sync.** This is a snapshot commit pipeline plus an opt-in experimental live read/write layer. It does not preserve Overleaf history, comments, or label-based positioning.
- **Does not replace Overleaf Premium Git integration.** That feature provides full bidirectional history; this extension does not claim to.
- **Live sync depends on internal protocol behavior.** Overleaf can break it any time. Use the ZIP route as the durable path.
- **Manual ZIP upload is the stable fallback.** It always works regardless of Overleaf API changes.
- **Branch must already exist** on GitHub with at least one commit.
- **Tree size cap.** The recursive GitHub tree API truncates very large repos; the extension refuses to diff in that case (use a target directory).
- **No file-mode tracking** — all files are committed as `100644`.
- **No automatic Overleaf login.** Sign in to Overleaf the normal way first.

## Architecture

```
extension/
├── manifest.config.ts                Build-time manifest source (CRXJS)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── background/serviceWorker.ts
│   ├── content/overleafContentScript.ts
│   ├── offscreen/                    Reserved for future Socket.IO keepalive
│   │   ├── offscreen.html
│   │   └── offscreen.ts
│   ├── popup/                        Three-section popup (Stable / Fallback / Experimental)
│   │   ├── popup.html
│   │   ├── popup.tsx
│   │   ├── PopupApp.tsx
│   │   └── popup.css
│   ├── options/                      Repo config + experimental settings
│   │   ├── options.html
│   │   ├── options.tsx
│   │   ├── OptionsApp.tsx
│   │   └── options.css
│   ├── github/
│   │   ├── auth.ts
│   │   ├── githubClient.ts
│   │   └── commitEngine.ts
│   ├── overleaf/
│   │   ├── overleafContext.ts        Active project-tab detection
│   │   ├── overleafZipClient.ts      Automatic ZIP route, typed errors
│   │   └── live/                     Experimental live sync (gated)
│   │       ├── types.ts
│   │       ├── liveSyncManager.ts
│   │       ├── overleafRealtimeClient.ts
│   │       ├── overleafProjectLoader.ts
│   │       ├── overleafDocumentClient.ts
│   │       ├── overleafFileClient.ts
│   │       ├── overleafOt.ts
│   │       ├── overleafWriteBack.ts
│   │       └── conflictDetector.ts
│   ├── localReplica/                 Experimental local folder mirror
│   │   ├── localReplicaTypes.ts
│   │   ├── localReplicaManager.ts
│   │   ├── localFolderAccess.ts
│   │   └── localConflictDetector.ts
│   ├── sources/                      Unified SourceSnapshot abstraction
│   │   ├── sourceTypes.ts
│   │   └── sourceManager.ts
│   ├── zip/
│   ├── diff/
│   ├── storage/
│   └── shared/
```

### SourceSnapshot abstraction

Every input mode normalizes to `SourceSnapshot.files: ProjectFile[]` before reaching the diff/commit pipeline:

| Mode | Module |
| --- | --- |
| `manual-zip` | `src/zip/zipReader.ts` via `src/sources/sourceManager.ts` |
| `overleaf-zip-route` | `src/overleaf/overleafZipClient.ts` |
| `overleaf-live-readonly` | `src/overleaf/live/liveSyncManager.ts` |
| `local-replica` | `src/localReplica/localReplicaManager.ts` |

This keeps the diff engine and commit engine source-agnostic.

### Typed errors and recovery

Every fetch surface returns typed errors with a `code` and a user-facing message:

| Layer | Error codes |
| --- | --- |
| Overleaf ZIP | `not_logged_in`, `forbidden`, `not_found`, `endpoint_changed`, `not_zip`, `network`, `zip_parse_failed`, `unknown` |
| Live sync | `live_sync_disabled`, `protocol_unavailable`, `socket_connection_failed`, `project_join_failed`, `document_join_failed`, `document_version_unknown`, `unsupported_file_type`, `remote_changed`, `write_back_disabled`, `write_back_not_safe`, `local_replica_unavailable`, `not_logged_in`, `forbidden`, `network`, `unknown` |

Each surface includes a recovery action the popup displays alongside the error.

## License note (Overleaf Workshop / AGPL)

Overleaf's open-source server and the Overleaf Workshop extension are AGPL-licensed. **This project does not copy AGPL code.** The experimental live-sync code is a clean-room reimplementation of the minimum protocol needed to discover project metadata and probe the real-time handshake. If the project ever needs deeper live-protocol parity, the AGPL implications must be revisited.

## Setup

### Prerequisites

- Node.js 18+ (20+ recommended).
- Chrome 110+ (any Chromium-based browser supporting Manifest V3 will do).

### Install

```bash
npm install
npm run build
```

Load the resulting `dist/` folder via `chrome://extensions` → **Developer mode** → **Load unpacked**.

### Develop

```bash
npm run dev
```

Vite watches sources and rebuilds `dist/`. Reload the extension in `chrome://extensions` to pick up changes.

### GitHub token

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. Pick a fine-grained token, scoped to a single repository.
3. Permissions: **Contents: Read and write**, **Metadata: Read-only**.
4. Paste in **Options → Personal access token** and save.
5. Use **Test GitHub connection** to verify.

## Day-to-day use

### Stable (automatic)

1. Open your project on Overleaf (`https://www.overleaf.com/project/...`).
2. Click the extension toolbar icon.
3. Click **Fetch from current Overleaf project**.
4. Review the diff and commit.

### Fallback (manual)

1. In Overleaf: **Menu → Source**, save the ZIP.
2. Click the extension icon.
3. Use the **Manual ZIP upload** section to pick the ZIP.
4. Review the diff and commit.

### Experimental (live)

1. Open **Options** and enable **Experimental Overleaf Live Sync** plus the specific capabilities you want.
2. In the popup, the **Experimental Live Sync** section becomes visible.
3. Click **Live read-only pull** (or use the write-back / local-replica UI in the options page when enabled). Conflicts are blocked; you must resolve them manually.

## Manual testing checklist

1. **Non-Overleaf tab** → automatic button is hidden; manual ZIP still works.
2. **Overleaf tab, signed in** → automatic ZIP route fetches, previews diff, commits.
3. **Overleaf tab, signed out** → automatic route fails with `not_logged_in`; manual fallback remains visible.
4. **ZIP endpoint changed** → typed `endpoint_changed`/`not_zip` error; manual fallback remains visible.
5. **Experimental disabled** → no live sync UI visible.
6. **Experimental enabled** → live read-only button visible (disabled until Overleaf tab is active).
7. **Live read-only failure** → ZIP mode still works.
8. **Write-back** → disabled by default; requires backup, confirmation; only allowed extensions; blocks on conflict.
9. **Local replica** → disabled by default; requires explicit folder selection; no background sync; conflict statuses display.

## License

MIT License. See [LICENSE](LICENSE).
