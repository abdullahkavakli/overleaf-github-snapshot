// Detect the currently-active Overleaf project tab so the popup can offer the
// "automatic" snapshot path instead of asking the user to upload a ZIP.
//
// The popup runs in a privileged extension context and is allowed to read tab
// state via the "activeTab" permission. We never read cookies, never touch
// document state, and never make network requests from this module — we only
// look at the URL of the foreground tab.

export type OverleafProjectContext = {
  projectId: string;
  projectUrl: string;
};

const OVERLEAF_PROJECT_REGEX =
  /^https:\/\/www\.overleaf\.com\/project\/([a-zA-Z0-9]+)(?:[\/?#].*)?$/;

const PROJECT_ID_REGEX = /^[a-zA-Z0-9]+$/;

export function extractOverleafProjectIdFromUrl(
  url: string | undefined,
): string | null {
  if (!url) return null;
  const m = url.match(OVERLEAF_PROJECT_REGEX);
  if (!m) return null;
  const id = m[1];
  if (!PROJECT_ID_REGEX.test(id)) return null;
  return id;
}

// Accept either a raw Overleaf project ID or a pasted project URL. Used by the
// Options "Add mapping" form so the user can paste whatever they have on hand.
export function normalizeOverleafProjectId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (PROJECT_ID_REGEX.test(trimmed)) return trimmed;
  return extractOverleafProjectIdFromUrl(trimmed);
}

export async function getActiveOverleafProjectContext(): Promise<OverleafProjectContext | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const url = tab?.url;
    const projectId = extractOverleafProjectIdFromUrl(url);
    if (!projectId || !url) return null;
    return { projectId, projectUrl: url };
  } catch {
    return null;
  }
}
