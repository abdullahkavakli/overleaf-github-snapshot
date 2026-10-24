import React from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './PopupApp';
import { getUIPreferences } from '../storage/extensionStorage';
import { applyTheme } from '../shared/theme';
import './popup.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Popup root element not found.');
}
// Apply the saved theme before the first render, so the popup doesn't
// flash the system theme first.
void getUIPreferences()
  .then((prefs) => applyTheme(prefs.theme))
  .catch(() => undefined)
  .finally(() => {
    createRoot(container).render(
      <React.StrictMode>
        <Popup />
      </React.StrictMode>,
    );
  });
