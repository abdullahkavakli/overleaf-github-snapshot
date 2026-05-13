# Overleaf Snapshot to GitHub

A Chrome Extension (Manifest V3) that commits an Overleaf project source ZIP to a GitHub repository — without needing **Overleaf Premium**, Overleaf's Git integration, or the Overleaf GitHub sync feature.

> **This extension does not provide true bidirectional Git sync. It creates GitHub commits from Overleaf source ZIP snapshots.**

The flow is one-way:

```
Overleaf source ZIP  →  parse files  →  diff against GitHub branch  →  preview  →  commit
```

## Table of contents

- [What it does](#what-it-does)
- [What it does not do](#what-it-does-not-do)
- [Why it works without Overleaf Premium](#why-it-works-without-overleaf-premium)
- [Architecture](#architecture)
- [Setup](#setup)
- [Creating a fine-grained GitHub token](#creating-a-fine-grained-github-token)
- [Downloading the Overleaf source ZIP](#downloading-the-overleaf-source-zip)
- [Loading the extension locally](#loading-the-extension-locally)
- [Day-to-day use](#day-to-day-use)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Manual testing checklist](#manual-testing-checklist)

## What it does

- Parses a downloaded Overleaf source ZIP entirely in your browser.
- Fetches the target branch tree from GitHub via the REST API.
- Computes a per-file diff: **added**, **modified**, **deleted**, **unchanged**.
- Shows you the diff, lets you toggle deletions, and lets you write a commit message.
- Creates a real GitHub commit using the Git Data API:
  1. Fetch the branch ref and current commit.
  2. Upload binary blobs.
  3. Build a new tree on top of the existing one (`base_tree`).
  4. Create a commit object pointing at that tree.
  5. Update the branch ref (`force: false` — never force-push).
- Provides a link to the new commit on GitHub.
- Injects a small "Commit to GitHub" launcher button on Overleaf project pages with instructions.

## What it does not do

- It does **not** automate the Overleaf ZIP download. You download it manually with **Menu → Source**.
- It does **not** scrape Overleaf private/internal APIs.
- It does **not** require Overleaf Premium, the Overleaf Git Bridge, or the GitHub sync feature.
- It does **not** pull GitHub changes back into Overleaf — this is one-way.
- It does **not** force-push, ever.
- It does **not** delete files outside the configured target directory.

## Why it works without Overleaf Premium

The extension never talks to Overleaf APIs at all. Overleaf's free **Menu → Source → Download as ZIP** is a public feature available to every Overleaf user. The extension only:

1. Reads a ZIP **file you provide** (via a regular `<input type="file">`).
2. Talks to `api.github.com` using **your own** personal access token.

There is no Overleaf credential, no Overleaf scraping, and no dependency on a paid Overleaf plan.

## Architecture

```
extension/
├── manifest.config.ts            Build-time manifest source (see note below)
├── package.json                  Build scripts, deps
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── background/
│   │   └── serviceWorker.ts      Lifecycle + minimal message router
│   ├── content/
│   │   └── overleafContentScript.ts
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.tsx             React mount
│   │   ├── PopupApp.tsx          React component (state machine)
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html
│   │   ├── options.tsx
│   │   ├── OptionsApp.tsx
│   │   └── options.css
│   ├── github/
│   │   ├── auth.ts               Token storage helpers
│   │   ├── githubClient.ts       Typed REST client + error formatter
│   │   └── commitEngine.ts       Tree/blob/commit/ref pipeline
│   ├── zip/
│   │   ├── zipReader.ts          fflate + ProjectFile build
│   │   └── normalizeZipPaths.ts  Path safety + top-level folder strip
│   ├── diff/
│   │   ├── fileHasher.ts         SHA-256 + git blob SHA-1
│   │   ├── ignoreRules.ts        Glob-like ignore patterns
│   │   └── diffEngine.ts         Three-way diff (zip × github × config)
│   ├── storage/
│   │   └── extensionStorage.ts   chrome.storage.local wrappers
│   └── shared/
│       ├── types.ts
│       └── constants.ts
```

> **Note on file naming.** The original brief listed `Popup.tsx` and `popup.tsx` side-by-side. On Windows / case-insensitive filesystems those two names collide, so the React component lives in `PopupApp.tsx` (and `OptionsApp.tsx`) while `popup.tsx` / `options.tsx` are the React DOM entry points. The runtime behavior is identical.

> **Note on `manifest.config.ts`.** The brief asked for `manifest.json` at the source root. We use [CRXJS's `defineManifest`](https://crxjs.dev/vite-plugin/concepts/file-input) in `manifest.config.ts` instead, and the build emits a real `manifest.json` into `dist/`. The reason is purely robustness: a source-root `manifest.json` would reference `.ts` files (which Chrome can't load), so if anyone ever pointed **Load unpacked** at the project root instead of `dist/`, they would see confusing errors like *"Invalid script mime type"* and *"Service worker registration failed. Status code: 11"*. Removing the source `manifest.json` makes that mistake impossible — Chrome refuses to load a folder with no manifest at all.

### Where GitHub API calls live

Per the security requirements, the **content script never sees the GitHub token**.

- The token is stored in `chrome.storage.local` via the **options page**.
- The **popup** and **options page** are privileged extension contexts (they have access to `chrome.storage.local`, `chrome.runtime`, and `host_permissions`) and they make the GitHub API calls directly. The popup loads the token from storage only when it needs to make a request.
- The **content script** is only used to inject the launcher button on `https://www.overleaf.com/project/*`. It never reads the token, never touches the repo configuration, and never makes API calls.
- The **service worker** handles install events and a minimal message bus for the content script.

### Diff algorithm

For each ZIP file:

1. Path is normalized: backslashes → slashes, leading `./` stripped, unsafe (`..`, absolute, Windows drive) paths rejected, directory entries dropped.
2. A common top-level folder (e.g. `MyProject/`) is stripped if all files share it. This is what Overleaf exports do.
3. Each file's Git blob SHA-1 is computed (`sha1("blob " + size + NUL + content)`) so we can compare directly against entries returned by `GET /git/trees/{sha}?recursive=1`.
4. Status:
   - `added` — path is in ZIP but not in GitHub tree (within target dir).
   - `modified` — path exists in both, but blob SHA differs.
   - `deleted` — path is in GitHub tree (within target dir) but not in ZIP.
   - `unchanged` — same SHA.

Deletions are always **scoped** to the configured target directory, and they are **off by default**. If you do not enable them, deleted files are shown in the preview as "skipped" and are not included in the commit payload.

### Commit pipeline

Steps for a single commit:

| Step | GitHub REST call |
| --- | --- |
| A | `GET  /repos/{o}/{r}/git/ref/heads/{branch}` |
| B | `GET  /repos/{o}/{r}/git/commits/{commit_sha}` |
| C | `GET  /repos/{o}/{r}/git/trees/{tree_sha}?recursive=1` |
| D | `POST /repos/{o}/{r}/git/blobs` *(one call per binary file)* |
| E | `POST /repos/{o}/{r}/git/trees` *(with `base_tree`)* |
| F | `POST /repos/{o}/{r}/git/commits` |
| G | `PATCH /repos/{o}/{r}/git/refs/heads/{branch}` *(force=false)* |

Text files are inlined into the tree as `content` directly (no separate blob call), saving round trips. Binaries always go through `POST /git/blobs` with base64 encoding. Deletions in the new tree use `{ sha: null }`.

## Setup

### Prerequisites

- Node.js 18+ (20+ recommended).
- Chrome 110+ (any Chromium-based browser supporting Manifest V3 will do).

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

This produces a `dist/` directory you can load as an unpacked extension.

### Develop

```bash
npm run dev
```

Vite watches sources and rebuilds `dist/`. You can reload the extension in `chrome://extensions` to pick up changes.

### Other scripts

- `npm run typecheck` — TypeScript without emitting.
- `npm run build:no-typecheck` — Build only (skip TS check). Useful if you're iterating fast.

## Creating a fine-grained GitHub token

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. Choose **Fine-grained token**.
3. **Resource owner**: pick the user or org that owns the repo.
4. **Repository access**: select **Only select repositories** and pick *one* repository — the one you'll commit Overleaf snapshots to.
5. **Repository permissions**:
   - **Contents** → **Read and write**
   - **Metadata** → **Read-only** (auto-selected)
6. Generate the token, copy it (you only see it once), paste it in the extension's **Options → Personal access token** field, and click **Save settings**.

Then use **Test GitHub Connection** in Options to verify the token, repo, branch, and write permission.

> Classic PATs with the `repo` scope also work but are broader than needed. Prefer fine-grained tokens.

## Downloading the Overleaf source ZIP

1. Open your project on Overleaf.
2. Click **Menu** (top-left).
3. Under **Download**, click **Source**.
4. Save the resulting ZIP somewhere convenient.

That ZIP is the input to this extension. You don't need to extract it.

## Loading the extension locally

1. `npm install && npm run build`
2. Open Chrome and navigate to `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked**.
5. **Select the `dist/` directory** — not the project root.
6. Pin the extension to your toolbar so you can click it easily.

After loading, the options page should open automatically on first install. Configure the token and repo, then go commit.

> ### ⚠️ "Invalid script mime type" / "Service worker registration failed. Status code: 11" / "MIME type of application/octet-stream"
>
> All three of those errors mean you loaded the **project root** instead of `dist/`. The project root has no `manifest.json` (intentionally — see the architecture section), so loading it fails. Run `npm run build` and choose the `dist/` folder.

## Day-to-day use

1. On Overleaf, **Menu → Source** to download the ZIP.
2. Click the extension's toolbar icon.
3. Pick the ZIP file in the popup.
4. Review the diff. Toggle **Include deletions** if you want files removed from the repo when they're gone from Overleaf.
5. Edit the commit message (default: `Sync Overleaf project`).
6. Click **Commit to GitHub**.
7. Click the resulting **View on GitHub →** link to inspect the commit.

The launcher button injected on Overleaf project pages opens a tooltip with the same instructions; the actual ZIP picker lives in the toolbar popup because content scripts can't open the extension popup or pick files for you.

## Security notes

- The GitHub token is stored only in `chrome.storage.local` under the key `github_token`. Chrome scopes this storage to the extension origin; web pages cannot read it.
- The **content script never sees the token** and never makes GitHub API calls. All API traffic comes from the popup or options page (both privileged extension contexts).
- The token is never written to the DOM, never put in URLs, never logged, and never sent anywhere except `https://api.github.com`.
- `host_permissions` is narrowed to `https://www.overleaf.com/*` and `https://api.github.com/*`.
- No remote code is loaded. No `eval`. No dynamic `<script>` tags. No CDN dependencies at runtime.
- Force-push is never used. The ref update sends `force: false`. If the branch moved between preview and commit you get a clear "branch changed" error and can refresh.
- ZIP paths are validated: absolute paths, paths containing `..`, and Windows-drive paths are rejected before they reach the diff engine.
- Deletions are off by default and are always scoped to the configured target directory.

## Known limitations

- **Manual ZIP download.** Overleaf doesn't expose a public ZIP API, and the brief explicitly forbids scraping the private one. You download the ZIP manually each time.
- **One-way.** GitHub changes are not pulled back into Overleaf.
- **No initial commit on empty branches.** The branch must already have at least one commit. Create an initial commit (e.g., a `README.md` via the GitHub UI) before pointing the extension at it.
- **Truncated trees.** If a repository has so many files that `GET /git/trees?recursive=1` returns `truncated: true`, the diff is refused. Use a target directory or a smaller repo. (You'll see a clear error in the popup.)
- **Per-file size limits.** Files larger than 50 MB are rejected client-side. GitHub's hard blob limit is 100 MB anyway.
- **Project size limit.** Total ZIP contents above ~200 MB are rejected.
- **Commit author.** Commits are authored by the token's owner; the author/committer is determined by GitHub, not configurable in the popup.
- **No file-mode tracking.** All files are committed with mode `100644` (regular file). Executable bits are not preserved.

## Troubleshooting

| Symptom | What's likely happening |
| --- | --- |
| Chrome: "Invalid script mime type" / "Service worker registration failed. Status code: 11" / module MIME = `application/octet-stream` | You loaded the project root, not `dist/`. Run `npm run build` and choose `dist/`. |
| Popup says "GitHub token is not set" | Open Options and paste a fine-grained PAT. |
| Test Connection: `Contents write permission: no` | Token only has read access — recreate it with **Contents: Read and write**. |
| Test Connection: `Branch found: no` | Branch doesn't exist on GitHub. Create the branch (or an initial commit) first. |
| "Repository or branch was not found, or the token cannot access it." | Either the repo path is wrong, or the token isn't scoped to that repo. Recreate the token and grant it access to the specific repo. |
| "GitHub branch changed since preview. Refresh the diff and try again." | Someone else pushed to the branch between when you previewed and when you committed. Click **Pick different ZIP** (or reopen the popup) to re-analyze. |
| "Repository tree is too large to compare." | The recursive tree response was truncated. Set a **Target directory** in Options to scope the comparison. |
| "Unsafe path in ZIP" | The ZIP contains a path that escapes the project root (`..`, absolute, drive-letter). Re-export the ZIP from Overleaf or report the file. |
| "ZIP contains no usable files after normalization." | The ZIP appears empty or only contains directory entries. Re-export from Overleaf via Menu → Source. |
| Launcher button on Overleaf doesn't open popup | Chrome MV3 doesn't let content scripts open the action popup. The button just shows instructions; click the extension icon yourself. |

## Manual testing checklist

A quick smoke test after building:

1. **Load unpacked** from `dist/`.
2. Options page opens automatically. Save a fine-grained token and a repo you own.
3. Click **Test GitHub Connection** — should report user, branch found, contents permission.
4. On Overleaf, open a project; verify the floating "Commit to GitHub" button appears in the lower-right.
5. Click the button — instruction tooltip should appear. Confirm it closes when clicking elsewhere.
6. **Menu → Source** in Overleaf, download the ZIP.
7. Open the extension popup, pick the ZIP.
8. Verify the diff preview shows sane add/modify/delete counts.
9. Commit with default message — verify the success card links to the new commit on GitHub.
10. Toggle **Include deletions** and verify the warning banner appears with the correct count.
11. Edit a `.tex` file in Overleaf, re-export, commit again — should show only modified files.
12. Try a malformed ZIP (rename a text file to `.zip`) — should produce a clean "Failed to read ZIP" error.
13. Set a **Target directory** in Options, re-commit — files should land under that directory in the repo.

## License

MIT License. See [LICENSE](LICENSE).
