# Privacy Policy

Effective date: 2026-05-16

Overleaf GitHub Snapshot is a Chrome extension that helps users create reviewed GitHub commits from Overleaf project source snapshots.

## Data processed by the extension

The extension may process the following data when you use it:

- GitHub personal access token that you enter into the extension.
- GitHub repository owner, repository name, branch, file metadata, and file contents needed to show diffs and create commits.
- Overleaf project source files and project metadata needed to fetch a source snapshot and show diffs.
- Extension settings, such as selected repository, branch, target directory, and experimental feature preferences.

## How data is stored

The extension stores settings and the GitHub token locally in Chrome extension storage on your device. The extension does not operate a separate backend server and does not upload your token or project contents to a server controlled by the extension developer.

## How data is transmitted

The extension sends your GitHub token only to `https://api.github.com/` when making GitHub API requests that you initiate or configure.

The extension accesses `https://www.overleaf.com/` to fetch project source snapshots using your existing Overleaf browser session. The extension does not request the `chrome.cookies` permission and does not read, copy, display, or store your Overleaf cookies.

## Data sharing

The extension does not sell user data. The extension does not use user data for advertising, creditworthiness, lending, or unrelated tracking. Data is shared only with GitHub and Overleaf as needed for the extension's user-requested functionality.

## Retention and deletion

Data stored by the extension remains in Chrome extension storage until you change it, clear extension data, or uninstall the extension. Uninstalling the extension removes its local Chrome storage according to Chrome's extension storage behavior.

## Contact

For support or privacy questions, open an issue at:

https://github.com/abdullahkavakli/overleaf-github-snapshot/issues
