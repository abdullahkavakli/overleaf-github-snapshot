import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json';

const icons = {
  '16': 'icons/icon-16.png',
  '32': 'icons/icon-32.png',
  '48': 'icons/icon-48.png',
  '128': 'icons/icon-128.png',
};

// The build-time source of truth for the extension manifest.
// At source root we intentionally keep NO manifest.json: it would point at
// TypeScript files (which Chrome cannot load), so users would see confusing
// MIME / "Service worker registration failed" errors if they ever pointed
// `Load unpacked` at the project root by mistake. Always load `dist/` after
// running `npm run build`.
export default defineManifest({
  manifest_version: 3,
  name: 'Overleaf Snapshot to GitHub',
  version: packageJson.version,
  description:
    'Commit Overleaf source ZIP snapshots to a GitHub repository. One-way snapshot, no Overleaf Premium needed.',
  icons,
  permissions: ['storage'],
  host_permissions: [
    'https://www.overleaf.com/*',
    'https://api.github.com/*',
  ],
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Overleaf Snapshot to GitHub',
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
