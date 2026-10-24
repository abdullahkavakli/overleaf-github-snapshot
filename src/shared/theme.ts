import type { ThemePreference } from './types';

// The stylesheets read `data-theme` on <html>: none follows the system
// (prefers-color-scheme), 'light' or 'dark' forces that palette.
export function applyTheme(theme: ThemePreference): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
