import type { CodexServiceTier } from '../types';

export const NORMAL_SERVICE_TIER_ID = 'default';

export function isNormalServiceTierId(id?: string | null): boolean {
  const normalized = id?.trim().toLocaleLowerCase();
  return normalized === NORMAL_SERVICE_TIER_ID || normalized === 'standard';
}

export function serviceTierDisplayName(
  tier: Pick<CodexServiceTier, 'id' | 'name'> | undefined,
  fallbackId?: string | null
): string {
  const id = tier?.id || fallbackId || '';
  const runtimeName = tier?.name?.trim();

  if (isNormalServiceTierId(id)) {
    return runtimeName && !['default', 'standard'].includes(runtimeName.toLocaleLowerCase())
      ? runtimeName
      : 'Normal';
  }

  // "priority" is the wire-level value. In the product this is the faster
  // processing option, so avoid exposing protocol jargon in session controls.
  if (id.toLocaleLowerCase() === 'priority') {
    return runtimeName && runtimeName.toLocaleLowerCase() !== 'priority'
      ? runtimeName
      : 'Fast';
  }

  if (runtimeName) return runtimeName;
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
