import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export const INTERFACE_SCALE_STORAGE_KEY = 'atcontroller:interface-scale-v1';
export const INTERFACE_SCALE_CHANGED_EVENT =
  'atcontroller:interface-scale-changed';
export const INTERFACE_SCALE_LEVELS = [
  0.8,
  0.9,
  1,
  1.1,
  1.2,
  1.3,
  1.4,
  1.5,
  1.6
] as const;
export const DEFAULT_INTERFACE_SCALE = 1;

export type InterfaceScaleAction = 'increase' | 'decrease' | 'reset';

function closestScale(value: number): number {
  return INTERFACE_SCALE_LEVELS.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value)
      ? candidate
      : closest
  );
}

export function normalizeInterfaceScale(value: unknown): number {
  if (value == null || value === '') return DEFAULT_INTERFACE_SCALE;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric)
    ? closestScale(numeric)
    : DEFAULT_INTERFACE_SCALE;
}

export function readStoredInterfaceScale(): number {
  if (typeof window === 'undefined') return DEFAULT_INTERFACE_SCALE;
  return normalizeInterfaceScale(
    window.localStorage.getItem(INTERFACE_SCALE_STORAGE_KEY)
  );
}

export function persistInterfaceScale(value: number): number {
  const scale = normalizeInterfaceScale(value);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(INTERFACE_SCALE_STORAGE_KEY, String(scale));
  }
  return scale;
}

export function nextInterfaceScale(
  current: number,
  action: InterfaceScaleAction
): number {
  if (action === 'reset') return DEFAULT_INTERFACE_SCALE;
  const scale = normalizeInterfaceScale(current);
  const index = INTERFACE_SCALE_LEVELS.indexOf(
    scale as (typeof INTERFACE_SCALE_LEVELS)[number]
  );
  const offset = action === 'increase' ? 1 : -1;
  const nextIndex = Math.min(
    INTERFACE_SCALE_LEVELS.length - 1,
    Math.max(0, index + offset)
  );
  return INTERFACE_SCALE_LEVELS[nextIndex];
}

export function interfaceScaleShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey'>
): InterfaceScaleAction | null {
  if (!event.metaKey || event.altKey || event.ctrlKey) return null;
  if (
    event.key === '+' ||
    event.key === '=' ||
    event.key === 'Add' ||
    event.code === 'Equal' ||
    event.code === 'NumpadAdd'
  ) {
    return 'increase';
  }
  if (
    event.key === '-' ||
    event.key === '_' ||
    event.key === 'Subtract' ||
    event.code === 'Minus' ||
    event.code === 'NumpadSubtract'
  ) {
    return 'decrease';
  }
  if (
    event.key === '0' ||
    event.code === 'Digit0' ||
    event.code === 'Numpad0'
  ) {
    return 'reset';
  }
  return null;
}

export function formatInterfaceScale(value: number): string {
  return `${Math.round(normalizeInterfaceScale(value) * 100)}%`;
}

export async function applyInterfaceScale(value: number): Promise<number> {
  const scale = normalizeInterfaceScale(value);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.interfaceScale = String(scale);
  }
  if (isTauri()) {
    await getCurrentWebview().setZoom(scale);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(INTERFACE_SCALE_CHANGED_EVENT));
  }
  return scale;
}
