import React from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './OptionsApp';
import './options.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Options root element not found.');
}
createRoot(container).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
);
