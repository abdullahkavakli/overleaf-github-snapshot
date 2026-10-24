import React from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './OptionsApp';
import { getUIPreferences } from '../storage/extensionStorage';
import { applyTheme } from '../shared/theme';
import './options.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Options root element not found.');
}
// Apply the saved theme before the first render, so the page doesn't
// flash the system theme first.
void getUIPreferences()
  .then((prefs) => applyTheme(prefs.theme))
  .catch(() => undefined)
  .finally(() => {
    createRoot(container).render(
      <React.StrictMode>
        <Options />
      </React.StrictMode>,
    );
  });
