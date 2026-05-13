import React from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './PopupApp';
import './popup.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Popup root element not found.');
}
createRoot(container).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
