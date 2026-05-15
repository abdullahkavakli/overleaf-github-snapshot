import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json';

const icons = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '128': 'icons/icon-128.png',
};

// Chrome's manifest_version field must be 1–4 dot-separated integers
// (e.g. "0.4.0"). SemVer pre-release strings like "0.4.0-alpha.1" are
// rejected by Chrome. We strip any "-…" suffix here so the npm/git side
// keeps the full SemVer identifier while the Chrome runtime sees a
// numeric-only version. version_name preserves the human-readable form
// inside chrome://extensions so alpha builds are still distinguishable.
const semver = packageJson.version;
const chromeVersion = semver.replace(/-.+$/, '');

// The build-time source of truth for the extension manifest.
// At source root we intentionally keep NO manifest.json: it would point at
// TypeScript files (which Chrome cannot load), so users would see confusing
// MIME / "Service worker registration failed" errors if they ever pointed
// `Load unpacked` at the project root by mistake. Always load `dist/` after
// running `npm run build`.
export default defineManifest({
  manifest_version: 3,
  name: 'Overleaf GitHub Snapshot',
  version: chromeVersion,
  version_name: semver !== chromeVersion ? semver : undefined,
  description:
    'Commit Overleaf project snapshots to GitHub; optional live read-only sync via Overleaf\'s session.',
  icons,
  permissions: ['storage', 'activeTab'],
  host_permissions: [
    'https://www.overleaf.com/*',
    'https://api.github.com/*',
  ],
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Overleaf GitHub Snapshot',
    default_icon: icons,
  },
  options_page: 'src/options/options.html',
  background: {
    service_worker: 'src/background/serviceWorker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://www.overleaf.com/project/*'],
      js: ['src/content/overleafContentScript.ts'],
      run_at: 'document_idle',
    },
  ],
});
