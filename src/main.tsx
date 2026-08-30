import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { applyAppearanceMode, readStoredAppearanceMode } from './lib/appearance';
import { api } from './lib/api';
import { installExternalNavigationGuard } from './lib/externalNavigation';
import {
  applyInterfaceScale,
  readStoredInterfaceScale
} from './lib/interfaceScale';

applyAppearanceMode(readStoredAppearanceMode());
installExternalNavigationGuard(
  (url) => api.openExternalUrl(url),
  (message) => {
    void api.reportFrontendError(message).catch(() => undefined);
  }
);
void applyInterfaceScale(readStoredInterfaceScale()).catch((error) => {
  void api
    .reportFrontendError(`Could not restore interface scale: ${String(error)}`)
    .catch(() => undefined);
});

window.addEventListener('error', (event) => {
  const detail = [event.message, event.filename, event.lineno, event.colno, event.error?.stack]
    .filter(Boolean)
    .join('\n');
  void api.reportFrontendError(detail || 'Unknown frontend error').catch(() => undefined);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason =
    event.reason instanceof Error
      ? `${event.reason.message}\n${event.reason.stack ?? ''}`
      : String(event.reason);
  void api.reportFrontendError(`Unhandled rejection: ${reason}`).catch(() => undefined);
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
