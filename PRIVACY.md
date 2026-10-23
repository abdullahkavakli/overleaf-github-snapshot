# Privacy Policy

Effective date: 2026-10-22

Overleaf GitHub Snapshot is a Chrome extension that helps users create reviewed GitHub commits from Overleaf project source snapshots. As a feature you can turn off in the extension options, it can also copy files from a GitHub branch into the Overleaf project and, if you tick the option "Make Overleaf match GitHub exactly", delete files from the project and replace uploaded files there, only after you confirm a preview.

## Data processed by the extension

The extension may process the following data when you use it:

- GitHub personal access token that you enter into the extension.
- GitHub repository owner, repository name, branch, file metadata, and file contents needed to show diffs and create commits.
- Overleaf project source files and project metadata needed to fetch a source snapshot and show diffs.
- If you use the pull into Overleaf: file contents from your GitHub branch, which the extension adds to or updates in your Overleaf project. If you also tick "Make Overleaf match GitHub exactly" (off by default), the pull can additionally delete files from your Overleaf project that are not on GitHub and replace uploaded files there with the GitHub version, only after you type a confirmation word. To decide what to change, the extension reads those Overleaf files, the repository's `.gitignore` files (which it fetches from GitHub like any other file in the branch) and your remembered choice for that option, which is stored locally for each Overleaf project separately; Overleaf keeps deleted and replaced files in the project's History.
- Extension settings, such as selected repository, branch, target directory, and experimental feature preferences.

## How data is stored

The extension stores settings and the GitHub token locally in Chrome extension storage on your device. While a pull into Overleaf runs, it also keeps a short-lived record in Chrome's session storage (the Overleaf project ID, a random ID for that pull, and an expiry time that is renewed while the pull runs and lapses about 90 seconds after it stops) so that two pulls of one project cannot run at once; the extension removes it when the pull ends, and Chrome clears it when the browser quits. The extension does not operate a separate backend server and does not upload your token or project contents to a server controlled by the extension developer.

## How data is transmitted

The extension sends your GitHub token only to `https://api.github.com/` when making GitHub API requests that you initiate or configure.

The extension accesses `https://www.overleaf.com/` to fetch project source snapshots using your existing Overleaf browser session and, only when you start a pull from GitHub (a feature you can turn off in the extension options) and confirm its preview, to add or update files in the project (and, with "Make Overleaf match GitHub exactly", to delete files from it). The extension does not request the `chrome.cookies` permission and does not read, copy, display, or store your Overleaf cookies.

## Data sharing

The extension does not sell user data. The extension does not use user data for advertising, creditworthiness, lending, or unrelated tracking. Data is shared only with GitHub and Overleaf as needed for the extension's user-requested functionality.

## Retention and deletion

Data stored by the extension remains in Chrome extension storage until you change it, clear extension data, or uninstall the extension. Uninstalling the extension removes its local Chrome storage according to Chrome's extension storage behavior.

## Contact

For support or privacy questions, open an issue at:

https://github.com/abdullahkavakli/overleaf-github-snapshot/issues
