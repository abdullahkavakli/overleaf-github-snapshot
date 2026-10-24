# Overleaf GitHub Snapshot

A Chrome extension (Manifest V3) that commits Overleaf project snapshots to a GitHub repository. You don't need **Overleaf Premium**, Overleaf's Git integration, or Overleaf's GitHub sync. It works on `www.overleaf.com` only.

Install from the Chrome Web Store: [Overleaf GitHub Snapshot](https://chromewebstore.google.com/detail/overleaf-github-snapshot/lghcgnlnondbifcmflgnlmlahhaolfmk)

## What it does

**Overleaf → GitHub.** Open an Overleaf project tab, click the extension icon, then **Fetch from current Overleaf project**. The extension downloads the project's source ZIP using your existing browser session and shows a diff against your GitHub branch. Nothing is committed until you confirm.

**Manual ZIP upload (optional, off by default).** Turn it on under **Options → Popup display → Enable manual ZIP upload** to get a fallback for when the automatic fetch fails: download the ZIP yourself in Overleaf (**File → Download → Download as source (.zip)**) and pick it under **Manual ZIP upload** in the popup. The section then appears when the automatic fetch fails or no Overleaf tab is open. It stays hidden when the project is too large to snapshot or has no files, because a ZIP you download yourself has the same problem. **Always show Manual ZIP upload** keeps it visible all the time. While the setting is off, the popup has no ZIP picker.

**Theme.** Under **Options → Appearance**, pick **Dark** (the default), **Light** or **System** (follows your computer) for the popup and the Options page.

**Live sync** has two features:

- **Read from the open Overleaf tab (Overleaf → GitHub), off by default:** reads every file from the open Overleaf tab instead of downloading the ZIP.
- **Pull from GitHub into Overleaf, on by default:** copies changed files from your GitHub branch into Overleaf, can add new files, and can make Overleaf match GitHub exactly. It shows what it will change and writes nothing until you confirm.

Each Overleaf project links to **its own** GitHub repository and token.

## Setup

### GitHub token

1. Fill in **Owner** and **Repository** first (the popup's setup form, or **Options → Add mapping**). Then click **Create a token on GitHub** under the token field. GitHub opens with the name, owner and permissions (**Contents: Read and write**, **Metadata: Read-only**) pre-filled.
2. Under **Repository access**, choose **Only select repositories** and pick the repo for that project. GitHub doesn't let this step be pre-filled.
3. Click **Generate token** and copy it.
4. Paste it into the token field, in the popup's setup form (shown when you open an unlinked project) or in **Options → Add mapping / Edit**.
5. Click **Test connection** to check it (in Options, each mapping has a **Test** button). Repeat per project; each project gets its own token. By default GitHub makes this token expire after 30 days, so create a new one when it expires.

### Link a project

Open the project on Overleaf and click the extension icon. If the project isn't linked yet, the popup shows a setup form: enter owner, repo, branch, an optional target directory and the token, then click **Save & continue**. You can manage all mappings under **Options**.

Upgrading from ≤ 0.4.x: your old single repo config pre-fills the form for the first project you link. Saving that form migrates the config.

## Usage

**Commit a snapshot.** With the project tab open, click **Fetch from current Overleaf project**, review the diff, then click **Commit to GitHub**. A commit deletes files on GitHub only when **Include deletions** is ticked.

**Read from the open Overleaf tab.** In **Options**, tick **Read from the open Overleaf tab** (under **Overleaf → GitHub** in **Overleaf Live Sync**; **Enable live sync** is on by default) and click **Save live sync settings**. A **Read from the open Overleaf tab** card appears in the popup. If any file can't be read, deletions are off for that commit, so a partial read can never remove files from GitHub.

**Pull from GitHub into Overleaf.**

1. The pull is on by default, so there is nothing to switch on. Under **Options → Overleaf Live Sync** you can keep the safety defaults: **Check that Overleaf can export the project first** and **Ask me to type 'replace' before replacing files** on, and the **Allowed write-back extensions** list (`.tex .bib .cls .sty .bst .md .txt`). To also upload new figures, PDFs and similar files, tick **Allow uploading new images and other non-text files**. After changing any of these, click **Save live sync settings**. If you turned the pull off earlier (**Enable live sync** or **Enable Overleaf write-back**), tick them again and save.
2. With the Overleaf project tab open, open the popup. If you want files that are on GitHub but not in Overleaf to be added, tick **Also create new files in Overleaf** first. Then click **Pull from GitHub into Overleaf**.
3. Review the preview. It lists the Overleaf files that will be replaced with the GitHub version, the new files that will be added, the images and other non-text files that will be uploaded, and the files left out, with the reason. Nothing has been written yet, and **Cancel** leaves Overleaf as it is.
4. If existing files will be replaced, type `replace` and click **Pull N files**. If the pull only adds files, the button alone confirms. A file edited in Overleaf after the preview is left as it is and reported.
5. The popup lists the result for each file. If the export check fails, the pull stops before writing anything; wait and try again. If the popup asks you to reload the Overleaf tab (this can happen right after an extension update), reload it and run the pull again.

**Make Overleaf match GitHub exactly.** For when GitHub is your main copy. Tick it in the pull section (it's remembered per project, and the button then reads **Pull and match GitHub**). The pull then also:

- deletes files and empty folders that exist only in Overleaf;
- replaces uploaded files (for example a `.gitignore` Overleaf keeps as an upload) whose content differs from GitHub's.

The preview lists what will be deleted and replaced, and you type `delete` to confirm (`delete N` with the exact number when more than 20 files or 30% of the project would go). It never deletes a file that is on GitHub, and it keeps build files (`.aux`, `.log`…), your ignore patterns, anything your repository's `.gitignore` excludes (such as PDFs Overleaf needs to compile), and anything under a GitHub submodule or symbolic link. It stops without changing anything if the setup looks wrong (for example a wrong branch or target directory). A file edited in Overleaf after the preview isn't deleted. Deleted and replaced files can be restored from Overleaf's **History**.

Things to know before pulling:

- **A pull replaces Overleaf edits that aren't on GitHub.** The preview shows which files; Overleaf's **History** can recover them. If in doubt, commit a snapshot to GitHub first.
- Keep the popup open until the pull finishes. If it closes, the pull stops; run it again and files that are already updated are skipped.
- Only one pull per project runs at a time. If a second one says another pull is running, wait for the first (or a couple of minutes if its window was closed).
- Unless you tick **Make Overleaf match GitHub exactly** for that project, a pull from GitHub never deletes files in Overleaf, and never replaces existing images or other non-text files.
- Files that differ only in Windows or Mac line endings count as the same, in both directions. A file edited in Overleaf is committed with normal line endings.
- Overleaf can't store emoji and a few other symbols and shows them as `�`, so a file that differs only by those counts as matching; a GitHub text file that isn't saved as UTF-8 is left out of the pull, with the reason in the preview.

## Security

- **Never sees your Overleaf cookie.** Requests use your browser's existing Overleaf sign-in. The extension never reads cookies, never requests the `cookies` permission and never asks for Overleaf credentials.
- **GitHub tokens stay on your device.** Each linked project has its own token, stored in this browser's extension storage, sent only to `api.github.com` and never passed to the Overleaf page. What a token can reach is up to you: pick only the project's repository when you create it.
- **Minimal permissions.** `storage`, `activeTab` and `scripting`. Host access is limited to `www.overleaf.com` and `api.github.com`. `scripting` is used only to re-inject the extension's own content script into Overleaf tabs that were open before an install or update.
- **No force push.** If the branch moved after your preview, the commit aborts.
- **No automatic writes.** Every commit and every Overleaf write needs an explicit click, and a pull shows what it will change before you confirm. A pull refuses to write a file when it detects a conflict or can't confirm the document version. Deleting files or replacing uploaded files (**Make Overleaf match GitHub exactly**, off by default for every project) also needs you to type `delete`, and skips any file that changed in Overleaf after the preview.
- **The export check keeps no copy.** Before writing, a pull downloads Overleaf's ZIP export only to confirm that the export works. The ZIP is not saved; use Overleaf's History to undo a pull.
- **Document text never appears in logs.** Diagnostics are off by default and, when enabled, record only the shape of messages, never text.

## Limitations

- These are snapshot commits, not Git sync: Overleaf history and comments are not preserved.
- The live features depend on Overleaf's internal interface and may break without notice.
- The GitHub branch must already exist and have at least one commit.
- Repositories with more files than GitHub lists in one request (about 100,000) can't be compared, even with a target directory.
- File modes are not tracked; every file is committed as `100644`.
- Unless you tick **Make Overleaf match GitHub exactly**, a pull never replaces existing images or other non-text files in Overleaf, and it doesn't change text files that Overleaf keeps as uploaded files (the preview lists them).
- A pull never adds a GitHub symbolic link (it holds a link target, not a file) or a submodule; the preview lists symbolic links as left out. With **Make Overleaf match GitHub exactly**, a file Overleaf holds under a path where GitHub has a submodule or symbolic link is kept, not compared.
- **Make Overleaf match GitHub exactly** reads your repository's `.gitignore` files (common patterns; `!` exceptions are skipped, which only keeps more). It doesn't read `.git/info/exclude` or your global git excludes.
- Names that differ only in how accented letters are encoded (for example a file created on a Mac) count as the same file.
- Local folder comparison (the local replica setting) isn't available yet.

## Development

Requires Node.js 24 (LTS) and Chrome 110+ (or another Chromium browser).

```bash
npm install
npm run build   # or: npm run dev (watch mode)
```

In `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `dist/`. After each rebuild, reload the extension.

Architecture, protocol notes and the manual test checklist are in [AGENTS.md](AGENTS.md).

## License

GNU Affero General Public License v3.0-or-later. See [LICENSE](LICENSE).

The project moved from MIT to AGPL-3.0 at `v0.4.0` because its live-sync layer adapts the protocol vocabulary of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), which is AGPL-3.0. Releases `v0.1.0` through `v0.3.2` remain MIT.
