import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { applyAppearanceMode, readStoredAppearanceMode } from './lib/appearance';

applyAppearanceMode(readStoredAppearanceMode());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
