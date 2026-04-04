import type { AppearanceMode } from '../types';

export const APPEARANCE_MODE_STORAGE_KEY = 'claudex:appearance-mode';
export const DEFAULT_APPEARANCE_MODE: AppearanceMode = 'system';

export function normalizeAppearanceMode(value: unknown): AppearanceMode {
  if (value === 'light' || value === 'system' || value === 'dark') {
    return value;
  }
  return DEFAULT_APPEARANCE_MODE;
}

export function readStoredAppearanceMode(): AppearanceMode {
  if (typeof window === 'undefined') {
    return DEFAULT_APPEARANCE_MODE;
  }
  return normalizeAppearanceMode(window.localStorage.getItem(APPEARANCE_MODE_STORAGE_KEY));
}

export function persistAppearanceMode(mode: AppearanceMode) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(APPEARANCE_MODE_STORAGE_KEY, mode);
}

export function resolveAppearanceTheme(mode: AppearanceMode): 'dark' | 'light' {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }
  return mode;
}

export function applyResolvedAppearance(theme: 'dark' | 'light') {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function applyAppearanceMode(mode: AppearanceMode) {
  applyResolvedAppearance(resolveAppearanceTheme(mode));
}
