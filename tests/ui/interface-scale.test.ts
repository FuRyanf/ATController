import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_INTERFACE_SCALE,
  INTERFACE_SCALE_CHANGED_EVENT,
  INTERFACE_SCALE_STORAGE_KEY,
  applyInterfaceScale,
  formatInterfaceScale,
  interfaceScaleShortcut,
  nextInterfaceScale,
  normalizeInterfaceScale,
  persistInterfaceScale,
  readStoredInterfaceScale
} from '../../src/lib/interfaceScale';

function shortcut(
  key: string,
  code: string,
  overrides: Partial<KeyboardEvent> = {}
) {
  return interfaceScaleShortcut({
    altKey: false,
    code,
    ctrlKey: false,
    key,
    metaKey: true,
    ...overrides
  });
}

describe('interface scale', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.interfaceScale;
  });

  it('moves through bounded native zoom levels and resets to 100%', () => {
    expect(nextInterfaceScale(1, 'increase')).toBe(1.1);
    expect(nextInterfaceScale(1, 'decrease')).toBe(0.9);
    expect(nextInterfaceScale(1.6, 'increase')).toBe(1.6);
    expect(nextInterfaceScale(0.8, 'decrease')).toBe(0.8);
    expect(nextInterfaceScale(1.4, 'reset')).toBe(DEFAULT_INTERFACE_SCALE);
    expect(formatInterfaceScale(1.2)).toBe('120%');
  });

  it('recognizes macOS plus, minus, and reset shortcuts across keyboard forms', () => {
    expect(shortcut('+', 'Equal')).toBe('increase');
    expect(shortcut('=', 'Equal')).toBe('increase');
    expect(shortcut('-', 'Minus')).toBe('decrease');
    expect(shortcut('0', 'Digit0')).toBe('reset');
    expect(shortcut('+', 'Equal', { metaKey: false })).toBeNull();
    expect(shortcut('+', 'Equal', { altKey: true })).toBeNull();
  });

  it('normalizes and persists the selected level between launches', () => {
    expect(normalizeInterfaceScale('1.28')).toBe(1.3);
    expect(normalizeInterfaceScale('invalid')).toBe(1);
    expect(readStoredInterfaceScale()).toBe(1);

    expect(persistInterfaceScale(1.2)).toBe(1.2);
    expect(window.localStorage.getItem(INTERFACE_SCALE_STORAGE_KEY)).toBe('1.2');
    expect(readStoredInterfaceScale()).toBe(1.2);
  });

  it('records the effective scale even outside the Tauri runtime', async () => {
    const changed = vi.fn();
    window.addEventListener(INTERFACE_SCALE_CHANGED_EVENT, changed);
    await expect(applyInterfaceScale(1.4)).resolves.toBe(1.4);
    expect(document.documentElement.dataset.interfaceScale).toBe('1.4');
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener(INTERFACE_SCALE_CHANGED_EVENT, changed);
  });
});
