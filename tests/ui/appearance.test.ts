import { beforeEach, describe, expect, it } from 'vitest';

import {
  APPEARANCE_MODE_STORAGE_KEY,
  DEFAULT_APPEARANCE_MODE,
  normalizeAppearanceMode,
  readStoredAppearanceMode
} from '../../src/lib/appearance';

describe('appearance defaults', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to system when no explicit appearance mode exists', () => {
    expect(DEFAULT_APPEARANCE_MODE).toBe('system');
    expect(normalizeAppearanceMode(undefined)).toBe('system');
    expect(readStoredAppearanceMode()).toBe('system');
  });

  it('falls back to system for invalid stored values', () => {
    window.localStorage.setItem(APPEARANCE_MODE_STORAGE_KEY, 'sepia');

    expect(readStoredAppearanceMode()).toBe('system');
  });
});
