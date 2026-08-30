export type ExternalUrlOpener = (url: string) => Promise<void> | void;

export function normalizeExternalHttpUrl(
  value: string,
  base = window.location.href
): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Keep third-party pages out of ATController's application webview. Tauri can
 * otherwise turn window.open() into a bare native webview with no browser
 * toolbar or reliable route back to the app.
 */
export function installExternalNavigationGuard(
  openExternal: ExternalUrlOpener,
  reportError: (message: string) => void = () => undefined
): () => void {
  const originalOpen = window.open;
  const route = (value: string) => {
    const url = normalizeExternalHttpUrl(value);
    if (!url) return;
    void Promise.resolve(openExternal(url)).catch((error) => {
      reportError(`Could not open external URL: ${String(error)}`);
    });
  };

  const guardedOpen: typeof window.open = ((value?: string | URL) => {
    if (value != null && String(value).trim()) route(String(value));
    return null;
  }) as typeof window.open;
  window.open = guardedOpen;

  const handleClick = (event: MouseEvent) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const url = normalizeExternalHttpUrl(anchor.href);
    if (!url) return;
    const current = new URL(window.location.href);
    const target = new URL(url);
    if (target.origin === current.origin) return;
    event.preventDefault();
    route(url);
  };
  window.addEventListener('click', handleClick);

  return () => {
    window.removeEventListener('click', handleClick);
    if (window.open === guardedOpen) window.open = originalOpen;
  };
}
