// Content script for Overleaf project pages.
//
// Scope:
//   - Detect project pages.
//   - Inject a small non-invasive launcher button styled to feel native
//     to Overleaf's UI (green primary, restrained shadow, Lato/system stack).
//   - Show an instruction tooltip when clicked.
//
// What this script must NEVER do:
//   - Read the GitHub token (it is not provided to content scripts).
//   - Scrape private Overleaf APIs.
//   - Touch Overleaf credentials, cookies, or DOM beyond our injected button.

const BUTTON_ID = 'overleaf-snapshot-launcher';
const TOOLTIP_ID = 'overleaf-snapshot-tooltip';
const STYLE_ID = 'overleaf-snapshot-style';

// Overleaf-ish green; close to the brand accent without being a literal trademark copy.
const BRAND = '#138a07';
const BRAND_HOVER = '#0e7405';
const BRAND_DARK = '#4caf50';

function projectIdFromUrl(): string | null {
  const m = location.pathname.match(/\/project\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483646;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: ${BRAND};
      color: #ffffff;
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 6px;
      padding: 7px 12px 7px 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Lato',
        'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18), 0 1px 2px rgba(0, 0, 0, 0.06);
      cursor: pointer;
      transition: background-color 0.15s ease, box-shadow 0.15s ease,
        transform 0.05s ease;
    }
    #${BUTTON_ID}:hover {
      background: ${BRAND_HOVER};
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22), 0 1px 3px rgba(0, 0, 0, 0.08);
    }
    #${BUTTON_ID}:active {
      transform: translateY(1px);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
    }
    #${BUTTON_ID}:focus-visible {
      outline: 2px solid ${BRAND_DARK};
      outline-offset: 2px;
    }
    #${BUTTON_ID} svg {
      width: 14px;
      height: 14px;
      flex: 0 0 14px;
      display: block;
    }

    #${TOOLTIP_ID} {
      position: fixed;
      right: 16px;
      bottom: 60px;
      z-index: 2147483647;
      max-width: 300px;
      background: #ffffff;
      color: #1f2328;
      border: 1px solid #d0d7de;
      border-radius: 8px;
      padding: 14px 16px 14px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Lato',
        'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-size: 12.5px;
      line-height: 1.5;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
      animation: ofs-fade-in 0.15s ease-out;
    }
    #${TOOLTIP_ID} .ofs-title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: ${BRAND};
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 10px;
      letter-spacing: -0.005em;
    }
    #${TOOLTIP_ID} .ofs-title::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${BRAND};
      box-shadow: 0 0 0 3px color-mix(in srgb, ${BRAND}, transparent 80%);
      flex: 0 0 8px;
    }
    #${TOOLTIP_ID} ol {
      margin: 0;
      padding-left: 20px;
      color: #1f2328;
    }
    #${TOOLTIP_ID} ol li {
      margin-bottom: 5px;
    }
    #${TOOLTIP_ID} ol li:last-child {
      margin-bottom: 0;
    }
    #${TOOLTIP_ID} ol li em,
    #${TOOLTIP_ID} ol li code {
      font-style: normal;
      font-family: ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas,
        'Liberation Mono', monospace;
      font-size: 11px;
      background: rgba(0, 0, 0, 0.05);
      padding: 1px 5px;
      border-radius: 4px;
      white-space: nowrap;
    }
    #${TOOLTIP_ID} .close {
      position: absolute;
      top: 6px;
      right: 8px;
      background: none;
      border: none;
      color: rgba(0, 0, 0, 0.45);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      transition: background 0.12s, color 0.12s;
    }
    #${TOOLTIP_ID} .close:hover {
      background: rgba(0, 0, 0, 0.06);
      color: rgba(0, 0, 0, 0.8);
    }
    #${TOOLTIP_ID} .close:focus-visible {
      outline: 2px solid ${BRAND_DARK};
      outline-offset: 1px;
    }

    @media (prefers-color-scheme: dark) {
      #${BUTTON_ID} {
        border-color: rgba(255, 255, 255, 0.08);
      }
      #${TOOLTIP_ID} {
        background: #1a1f24;
        color: #e6edf3;
        border-color: #30363d;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3);
      }
      #${TOOLTIP_ID} .ofs-title {
        color: ${BRAND_DARK};
      }
      #${TOOLTIP_ID} .ofs-title::before {
        background: ${BRAND_DARK};
        box-shadow: 0 0 0 3px color-mix(in srgb, ${BRAND_DARK}, transparent 75%);
      }
      #${TOOLTIP_ID} ol {
        color: #e6edf3;
      }
      #${TOOLTIP_ID} ol li em,
      #${TOOLTIP_ID} ol li code {
        background: rgba(255, 255, 255, 0.08);
      }
      #${TOOLTIP_ID} .close {
        color: rgba(255, 255, 255, 0.55);
      }
      #${TOOLTIP_ID} .close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
      }
    }

    @keyframes ofs-fade-in {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #${TOOLTIP_ID} {
        animation: none;
      }
      #${BUTTON_ID} {
        transition: none;
      }
    }
  `;
  document.documentElement.appendChild(style);
}

function removeTooltip(): void {
  document.getElementById(TOOLTIP_ID)?.remove();
}

function showTooltip(): void {
  removeTooltip();
  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-modal', 'false');
  tooltip.setAttribute('aria-labelledby', `${TOOLTIP_ID}-title`);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.setAttribute('aria-label', 'Close instructions');
  close.textContent = '×';

  const title = document.createElement('div');
  title.id = `${TOOLTIP_ID}-title`;
  title.className = 'ofs-title';
  title.textContent = 'Commit to GitHub';

  const ol = document.createElement('ol');
  ol.innerHTML = `
    <li>In Overleaf, open <em>Menu &rarr; Source</em> and download the ZIP.</li>
    <li>Click the <em>Overleaf Snapshot to GitHub</em> icon in your browser toolbar.</li>
    <li>Select the ZIP, review the diff, and commit.</li>
  `;

  tooltip.appendChild(close);
  tooltip.appendChild(title);
  tooltip.appendChild(ol);
  document.body.appendChild(tooltip);

  close.addEventListener('click', () => {
    removeTooltip();
    document.getElementById(BUTTON_ID)?.focus();
  });

  // Dismiss on outside click (deferred so the originating click doesn't immediately close it).
  setTimeout(() => {
    function dismiss(ev: MouseEvent): void {
      const target = ev.target as Node | null;
      if (target && tooltip.contains(target)) return;
      removeTooltip();
      document.removeEventListener('click', dismiss, true);
    }
    document.addEventListener('click', dismiss, { capture: true });

    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        removeTooltip();
        document.getElementById(BUTTON_ID)?.focus();
        document.removeEventListener('keydown', onKey);
      }
    }
    document.addEventListener('keydown', onKey);
  }, 0);
}

function injectButton(): void {
  if (document.getElementById(BUTTON_ID)) return;
  if (!document.body) return;
  injectStyles();

  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.title = 'Commit Overleaf snapshot to GitHub';
  btn.setAttribute('aria-label', 'Commit Overleaf snapshot to GitHub');
  btn.setAttribute('aria-haspopup', 'dialog');

  // Inline GitHub mark — recognizable visual link to the action target.
  // path data from the Octicons mark-github icon, MIT-licensed.
  btn.innerHTML = `
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/>
    </svg>
    <span>Commit to GitHub</span>
  `;

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      chrome.runtime.sendMessage(
        { type: 'OVERLEAF_BUTTON_CLICKED', projectId: projectIdFromUrl() ?? undefined },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // Service worker may not be active; ignore.
    }
    showTooltip();
  });

  document.body.appendChild(btn);
}

function removeButton(): void {
  document.getElementById(BUTTON_ID)?.remove();
  removeTooltip();
}

function syncWithUrl(): void {
  if (projectIdFromUrl()) {
    injectButton();
  } else {
    removeButton();
  }
}

// Initial pass + observe for SPA route changes inside Overleaf.
syncWithUrl();

let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    syncWithUrl();
  } else if (projectIdFromUrl() && !document.getElementById(BUTTON_ID)) {
    injectButton();
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });
