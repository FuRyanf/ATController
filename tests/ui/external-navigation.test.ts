import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installExternalNavigationGuard,
  normalizeExternalHttpUrl
} from '../../src/lib/externalNavigation';

describe('external navigation guard', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
  });

  it('routes window.open HTTP(S) targets outside the app webview', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    cleanup = installExternalNavigationGuard(openExternal);

    expect(window.open('https://github.com/login')).toBeNull();
    expect(window.open()).toBeNull();
    window.open('javascript:alert(1)');

    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://github.com/login')
    );
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('intercepts otherwise-unhandled external anchors', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    cleanup = installExternalNavigationGuard(openExternal);
    const anchor = document.createElement('a');
    anchor.href = 'https://www.linkedin.com/help';
    anchor.textContent = 'Help';
    document.body.append(anchor);

    anchor.click();

    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://www.linkedin.com/help')
    );
  });

  it('normalizes only HTTP(S) URLs', () => {
    expect(normalizeExternalHttpUrl('https://example.com/path')).toBe(
      'https://example.com/path'
    );
    expect(normalizeExternalHttpUrl('file:///tmp/private')).toBeNull();
    expect(normalizeExternalHttpUrl('javascript:alert(1)')).toBeNull();
  });
});
