# Overleaf GitHub Snapshot

A Chrome Extension (Manifest V3) that commits Overleaf project snapshots to a GitHub repository — without needing **Overleaf Premium**, Overleaf's Git integration, or the Overleaf GitHub sync feature.

## Install

Install from the Chrome Web Store: [Overleaf GitHub Snapshot](https://chromewebstore.google.com/detail/overleaf-github-snapshot/lghcgnlnondbifcmflgnlmlahhaolfmk)

> **The stable workflow is one-way: Overleaf → GitHub via ZIP snapshots.** Starting with `v1.1.0`, an experimental **GitHub → Overleaf pull** direction is also available — text writes via OT, doc creation, and binary uploads. It is gated behind opt-in flags, runs every write through a per-file conflict detector + ZIP-backup safety gate, and is still labelled clearly experimental: Overleaf's live protocol can change without notice, in which case the stable ZIP route remains the durable path.

## What this extension does

It commits Overleaf project snapshots to GitHub, and (as of `v1.1.0`, opt-in experimental) can pull GitHub changes back into Overleaf.

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

There is also an opt-in **Experimental Overleaf Live Sync** section in the options page. It is disabled by default and clearly marked experimental. Since `v1.1.0` this section also exposes the reverse direction — **Pull from GitHub into Overleaf** — which writes changed text docs back via Overleaf's OT protocol, creates new docs, and uploads new binaries.

### Per-project mappings

Each Overleaf project is linked to **its own** GitHub repository and **its own** GitHub token (strictly one project → one repo). When you open a project tab, the popup auto-resolves that project's repo; the first time you open an unlinked project it shows an inline setup form. All mappings can also be managed from the options page. Tokens are stored per mapping in `chrome.storage.local`.

**Migration from ≤ 0.4.x.** The old single repo config + token are read once and used to pre-fill the inline setup form for the first project you link; saving that mapping migrates and clears the legacy keys. Nothing is sent anywhere during migration.

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

Starting with `v1.0.0`, the popup hides the **Manual ZIP upload** section by default whenever an Overleaf project tab is open, so the automatic route is the obvious first action. It appears automatically the moment the automatic fetch fails, and the error view also keeps an inline ZIP picker visible so you can recover in one click. With **no** Overleaf project tab open, the manual section is shown immediately — it's the only option in that flow.

If you prefer the pre-1.0 behavior where the manual section is always visible, enable **Options → Popup display → Always show Manual ZIP upload**.

### C. Experimental — Overleaf Live Sync (off by default)

The options page contains an **Experimental Overleaf Live Sync** section, fully disabled by default. As of `v1.1.0` the two halves (read direction and write direction) are independently toggleable — you can enable the GitHub → Overleaf pull without enabling the slower Overleaf → GitHub read.

- **Live read-only pull (Overleaf → GitHub)** *(functional; protocol-dependent)* — pulls every doc and file in the project from Overleaf's live session, runs the same diff/commit pipeline as the ZIP route. **Architecture**: the popup messages the overleaf.com content script via `chrome.tabs.sendMessage`; the content script opens a Socket.IO 0.9 connection from the page origin (`www.overleaf.com`), runs `joinProject` to enumerate the file tree, `joinDoc` for each editable document, and `GET /project/<id>/file/<fileId>` for each static file. The session/CSRF flow uses the browser's existing Overleaf session via `credentials: "include"` and reads the CSRF token from the project page's `<meta name="ol-csrfToken">`. **The extension never reads `document.cookie` and never requests the `chrome.cookies` permission.** This depends on Overleaf's *internal, undocumented* real-time protocol — it can break without notice if Overleaf changes it, so the ZIP route remains the durable, recommended path. **Diagnostics:** live-sync diagnostic logging is **off by default** and, when explicitly opted in, emits only **structural frame shape** (string *lengths*, array/object structure, protocol field names, numeric versions) — **never document content**. Opt in by running `localStorage.setItem('ofs-live-debug','1')` in the Overleaf tab's DevTools console, then re-running the pull; clear it with `'0'`.
- **Overleaf write-back (GitHub → Overleaf)** *(functional; protocol-dependent — added in `v1.1.0`)* — reads the linked GitHub branch and writes each changed text file back to Overleaf via the same Socket.IO bridge. Every write goes through a **conflict detector** (re-reads the current Overleaf doc immediately before write; refuses if the remote moved since the user's base snapshot), the **OT helper** (`diffToOps` produces a single delete+insert pair that's `applyOtUpdate`-shaped), then a **verify read** that confirms the post-write text byte-for-byte. A **ZIP backup gate** is on by default — write-back refuses to proceed if a fresh ZIP snapshot of the project can't be fetched, so you always have a known-good rollback point. **Optional create-mode** (off by default — separate checkbox in the popup): creates docs and parent folders for files present in GitHub but not in Overleaf, seeding initial content via `applyOtUpdate` from v0. **Binary uploads** are also opt-in via the existing `Allow binary file write-back` toggle: new files in GitHub get uploaded via the same multipart endpoint Overleaf's drag-drop UI uses; files that already exist in Overleaf are skipped (binary replace is not yet implemented). Failures are per-file and never abort the rest of the pull.
- **Local replica prototype** *(module only — no UI)* — `localReplicaManager`, `localFolderAccess`, and the three-way `localConflictDetector` are implemented, but there is no UI that picks a folder, compares, or pulls. The File System Access API requirement is real for when the UI lands. See "Local replica prototype" below for the planned shape.

Each experimental capability has its own settings toggle. Settings include:

- Enable live read-only pull (default OFF) — gates the *Overleaf → GitHub* direction
- Enable Overleaf write-back (default OFF) — gates the *GitHub → Overleaf* direction
- Require ZIP backup before write-back (default ON, **strongly recommended on**)
- Require typed confirmation before write-back (default ON)
- Allow binary file write-back (default OFF)
- Allowed write-back extensions (default `.tex`, `.bib`, `.cls`, `.sty`, `.bst`, `.md`, `.txt`)

The popup also exposes a **Popup display** preference: *Always show Manual ZIP upload* (default OFF; manual section is hidden until automatic fetch fails in the current popup session — see section B above).

For development / validation the options page also exposes two **developer panels** when `overleafWriteBackEnabled` is on:
- **Developer write-back test** — single-doc round-trip harness: pick a project + doc path, Read current, edit a textarea, Write back. Useful for proving the OT path against a specific doc without touching GitHub.
- **Pull from GitHub into Overleaf** (dev variant) — same flow as the popup section but with a dropdown to pick *any* linked project, so you can test cross-project pulls.

> **Important.** Live sync (both directions) depends on Overleaf's internal Socket.IO 0.9 protocol staying compatible. The stable ZIP route is always available as a fallback. If live read-only returns a snapshot with fetch warnings, the popup blocks deletion-style commits until warnings clear, so partial fetches cannot silently remove files from your GitHub branch. The write-back ZIP-backup gate plays the analogous safety role for the reverse direction.

### D. Reverse mode — Pull from GitHub into Overleaf (opt-in, `v1.1.0`)

When *Enable Overleaf write-back* is on, the popup grows a **Pull from GitHub into Overleaf** section (visible only when an Overleaf project tab is open — the bridge writes from the overleaf.com origin so the tab is mandatory). The flow:

```
Read GitHub HEAD of linked branch (parallel blob fetches, allowed-extensions pre-filter)
   →  Resolve Overleaf doc / fileRef IDs via the live bridge
   →  Per file:
         text doc that exists in both    →  read current Overleaf, conflict-check
                                            against the just-read base, write
         text doc in GitHub only         →  if "Also create new files" is checked:
                                            mkdir parent folders, POST /doc,
                                            seed content via applyOtUpdate
         binary in GitHub only           →  if "Also create new files" is checked
                                            AND "Allow binary write-back" is on:
                                            mkdir parents, POST /upload (multipart)
         binary that exists in Overleaf  →  skip (replace-on-upload is a planned
                                            follow-on; not in this build)
   →  Display per-file results in three groups: write, create, binary upload
```

The summary banner counts each outcome explicitly: `N written · M skipped · K conflict · J failed · created · upload-skipped · …`. Every per-file failure surfaces with the raw HTTP / protocol response, so debugging wire-format issues against future Overleaf changes is straightforward.

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
- **GitHub token isolation.** Each project's GitHub PAT is stored only in `chrome.storage.local` (per-project, inside the project-links map). It is only sent to `api.github.com`. The content script never receives it.
- **Narrow permissions.** `storage`, `activeTab`, and `scripting` only. The `scripting` permission (added in `v1.0.0`) is used solely to re-inject the same overleaf.com content script the manifest already declares, into tabs that were opened before the extension was installed/updated — it grants no access beyond the host permissions below.
- **Narrow host permissions.** `https://www.overleaf.com/*` and `https://api.github.com/*` only.
- **No force push, ever.** The Git ref update always sends `force: false`. If the branch moved between preview and commit, the commit aborts cleanly.
- **No destructive automatic sync.** All write-back actions, local-replica pulls, and Overleaf writes require explicit user gestures.
- **Strict conflict detection.** Write-back refuses to overwrite a file whose remote SHA differs from the user's base snapshot.
- **Versioning gating.** If safe Overleaf document versioning cannot be confirmed, write-back returns `write_back_not_safe` instead of attempting a blind replace.
- **No document content in logs.** Live-sync diagnostics are off by default. When explicitly opted in (`localStorage['ofs-live-debug']='1'`), the logger emits only structural frame shape — string *lengths*, array/object structure, protocol field names, numeric versions — and **never** the characters of any document line.

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
│   ├── content/
│   │   ├── overleafContentScript.ts  Bridge dispatcher (LIVE_* messages)
│   │   ├── liveBridgeHandler.ts      joinProject + joinDoc + applyOtUpdate +
│   │   │                              folder/doc create + multipart upload
│   │   └── socketIo09.ts             Hand-rolled Socket.IO 0.9 / Engine.IO 0.x
│   ├── offscreen/                    Reserved for future Socket.IO keepalive
│   │   ├── offscreen.html
│   │   └── offscreen.ts
│   ├── popup/                        Sectioned popup (Stable / Fallback /
│   │   ├── popup.html                experimental Live read-only /
│   │   ├── popup.tsx                 experimental Pull from GitHub)
│   │   ├── PopupApp.tsx
│   │   └── popup.css
│   ├── options/                      Per-feature experimental cards + dev
│   │   ├── options.html              panels (write-back test, pull dev)
│   │   ├── options.tsx
│   │   ├── OptionsApp.tsx
│   │   └── options.css
│   ├── github/
│   │   ├── auth.ts
│   │   ├── githubClient.ts           Adds getBlob in v1.1.0 for pull
│   │   └── commitEngine.ts
│   ├── overleaf/
│   │   ├── overleafContext.ts        Active project-tab detection
│   │   ├── overleafZipClient.ts      Automatic ZIP route, typed errors
│   │   └── live/                     Experimental live sync (gated)
│   │       ├── types.ts
│   │       ├── bridgeProtocol.ts     LIVE_* message types, OtOp re-export
│   │       ├── bridgeClient.ts       Popup-side wrappers for every
│   │       │                          LIVE_* message + auto-inject retry
│   │       ├── liveSyncManager.ts    Read-only pull orchestrator +
│   │       │                          sendBridgeRequest (auto-inject path)
│   │       ├── overleafRealtimeClient.ts  BridgeDocChannel
│   │       ├── overleafProjectLoader.ts
│   │       ├── overleafDocumentClient.ts
│   │       ├── overleafFileClient.ts
│   │       ├── overleafOt.ts         diffToOps (insert/delete clean-room)
│   │       ├── overleafWriteBack.ts  writeSelectedFilesBackToOverleaf
│   │       │                          (ZIP backup + conflict detect + verify)
│   │       └── conflictDetector.ts
│   ├── localReplica/                 Experimental local folder mirror
│   │   ├── localReplicaTypes.ts
│   │   ├── localReplicaManager.ts
│   │   ├── localFolderAccess.ts
│   │   └── localConflictDetector.ts
│   ├── sources/                      Source modes feeding the diff pipeline
│   │   ├── sourceTypes.ts
│   │   ├── sourceManager.ts          Manual ZIP + Overleaf-ZIP route
│   │   ├── sourceFromGitHubBranch.ts GitHub branch -> ProjectFile[] (parallel
│   │   │                              blob fetches, extension pre-filter)
│   │   └── pullFromGitHubHelpers.ts  Create-missing-docs + upload-binaries
│   │                                   helpers shared by popup + Options
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

## License note (AGPL-3.0)

**This project is licensed under the GNU Affero General Public License v3.0-or-later** (see `LICENSE`).

We relicensed from MIT → AGPL-3.0 starting with `v0.4.0` because the experimental live-sync architecture is derived from [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) (AGPL-3.0). Specifically, the project-entities REST flow, the Socket.IO 0.9 protocol surface used to read documents, and the joinProject/joinDoc/applyOtUpdate event vocabulary are adapted from Workshop's source — adapted rather than copied verbatim, but close enough that AGPL-3.0 is the only license compatible with the dependency.

What this means practically:

- You may use, modify, and redistribute this extension freely under AGPL-3.0.
- If you distribute a modified version, or expose a modified version as a network service, you must publish the corresponding source code under AGPL-3.0 too. (See the `LICENSE` file for the full terms.)
- Versions `v0.1.0` through `v0.3.2` were released under MIT. Those tagged releases remain MIT; the relicensing applies to `v0.4.0` and later. If you need the MIT-licensed code path, check out `v0.3.2` or earlier.

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
2. Pick a fine-grained token, scoped to the single repository for that project.
3. Permissions: **Contents: Read and write**, **Metadata: Read-only**.
4. Paste it into the project's mapping — either the popup's inline setup form (shown when you open an unlinked project) or **Options → Add mapping / Edit**.
5. Use **Test** (per mapping) to verify. Repeat per project; each project gets its own narrowly-scoped token.

## Day-to-day use

### First time: link a project

1. Open the project on Overleaf (`https://www.overleaf.com/project/...`).
2. Click the extension icon. Because the project isn't linked yet, the popup shows an inline **link this project to a GitHub repo** form (pre-filled from your old single config if you're upgrading from ≤ 0.4.x).
3. Enter owner / repo / branch / optional target dir / token, optionally **Test connection**, then **Save & continue**.
4. The mapping is stored; next time you open this project the popup goes straight to the snapshot screen.

### Stable (automatic)

1. Open your project on Overleaf (`https://www.overleaf.com/project/...`). The popup auto-resolves this project's linked repo.
2. Click the extension toolbar icon.
3. Click **Fetch from current Overleaf project**.
4. Review the diff and commit (to this project's repo).

### Fallback (manual)

1. In Overleaf: **Menu → Source**, save the ZIP.
2. Click the extension icon. With the project tab open it resolves that project's repo; with **no** Overleaf tab open it shows a picker to choose which linked project's repo to target.
3. Use the **Manual ZIP upload** section to pick the ZIP.
4. Review the diff and commit.

### Experimental — Live read-only pull (Overleaf → GitHub)

1. Open **Options** and enable the master **Experimental Overleaf Live Sync** plus **Enable live read-only pull (Overleaf → GitHub)**.
2. In the popup, the **Live read-only pull** section becomes a separate card.
3. With an Overleaf project tab open and signed in, click **Live read-only pull**. The popup messages the content script on that tab; the content script opens a Socket.IO 0.9 channel to Overleaf, runs `joinProject` + `joinDoc` for every text doc, fetches static files over REST, and returns a complete snapshot to the diff/commit pipeline. If any doc or file fails, the snapshot carries warnings and the popup blocks deletion-style commits as a safety net. If the Overleaf tab was opened before the extension was installed/updated, the popup auto-injects the content-script bridge into that tab on first use of any live-sync action — no manual refresh needed (uses the `scripting` permission added in `v1.0.0`).

### Reverse — Pull from GitHub into Overleaf (`v1.1.0`)

1. Open **Options** and enable the master **Experimental Overleaf Live Sync** plus **Enable Overleaf write-back (GitHub → Overleaf)**. Leave the safety toggles at their defaults (ZIP backup ON, allowed extensions list pre-filled).
2. (Optional) Turn on **Allow binary file write-back** if you want figures / PDFs etc. uploaded too.
3. In the popup, the **Pull from GitHub into Overleaf** card appears in the experimental section (only when an Overleaf project tab is open).
4. (Optional, default OFF) Tick **Also create new files in Overleaf** to additionally create docs / upload binaries that don't exist in Overleaf yet.
5. Click **Pull from GitHub into Overleaf** → confirm. The popup fetches the linked GitHub branch, reads matching Overleaf docs as the TOCTOU base, runs `writeSelectedFilesBackToOverleaf` for text + the create / upload paths for new files, and shows per-file results.
6. **If the ZIP backup gate fails** (e.g. Overleaf returns a transient 500), the whole pull aborts before any write — this is intentional. Wait a minute and retry; do *not* leave the ZIP-backup toggle off as a workaround in real use.
7. Per-file failures are surfaced with the raw response, so future protocol-change debugging is straightforward.

## Manual testing checklist

User-runnable surfaces in this build:

**Stable + read-direction:**

1. **Non-Overleaf tab** → automatic button is hidden; manual ZIP still works.
2. **Overleaf tab, signed in** → automatic ZIP route fetches, previews diff, commits.
3. **Overleaf tab, signed out** → automatic route fails with `not_logged_in`; manual fallback remains visible.
4. **ZIP endpoint changed** → typed `endpoint_changed`/`not_zip` error; manual fallback remains visible.
5. **Experimental disabled** → no live sync UI visible in popup.
6. **Live read-only pull enabled, Overleaf tab open and signed in** → live read-only pull connects via the content-script bridge, joinProject enumerates the tree, joinDoc reads every text document, REST fetches every static file, the popup shows the diff and commits to GitHub.
7. **Live sync enabled, Overleaf tab opened before install/update** → first bridge ping fails internally; the extension auto-injects the content script via the `scripting` permission, retries the ping, and the call succeeds without a manual tab refresh. Applies to every live-bridge call, not just the read-only pull.
8. **Live snapshot with fetch warnings** → deletion checkbox is disabled, deletions banner is suppressed, commit handler enforces `includeDeletions=false` as defense in depth.
9. **Live read-only fails** → ZIP mode still works (use the green primary button instead).

**Write direction — added in `v1.1.0`:**

10. **Overleaf write-back disabled** → no Pull-from-GitHub section visible.
11. **Pull with no GitHub-side change** → all matching docs report `skipped — No local change versus base`. The conflict detector correctly short-circuits when GitHub HEAD == Overleaf content.
12. **Pull with a single character changed in an existing `.tex`** → that one file reports `written`, the rest `skipped`. The `applyOtUpdate` delete+insert path at v>0 is exercised against the real document.
13. **Pull with "Also create new files" on, brand-new `.tex` in GitHub not in Overleaf** → `created — path/file.tex: v1 (N bytes)` row appears; the new doc shows in Overleaf with seeded content. Parent folders are mkdir-ed on demand.
14. **Pull with "Allow binary write-back" + "Also create new files" both on, new PNG in GitHub** → `uploaded — path/file.png: N bytes`. Existing binaries report `skipped — replace-on-upload not implemented`.
15. **Pull with ZIP backup gate enabled and Overleaf returning 5xx on the ZIP endpoint** → the entire write-back aborts with `write_back_not_safe`. No Overleaf-side data is touched. This is intentional safety behaviour.
16. **Developer write-back test (Options panel)** → single-doc round-trip: Read → edit textarea → Write back returns `written`, then Overleaf shows the change.

Not user-runnable yet (modules exist but are not invoked):

- **Replace-on-upload for binaries** — existing fileRefs are explicitly skipped to avoid a DELETE+POST behind the user's back. Slated for a future release.
- **Deletions** — files in Overleaf with no GitHub source are not removed in either direction.
- **Local replica** — `localReplicaManager` and its three-way conflict detector exist, but no folder picker or compare UI is wired up.

These are slated for a future release.

## License

GNU Affero General Public License v3.0-or-later. See [LICENSE](LICENSE).

`v0.1.0` – `v0.3.2` were released under MIT; relicensing to AGPL-3.0 took effect with `v0.4.0`. See the [License note](#license-note-agpl-30) above for the rationale (Overleaf Workshop derivation).
