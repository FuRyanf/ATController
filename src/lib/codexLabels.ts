import type { CodexServiceTier } from '../types';

export function serviceTierDisplayName(
  tier: Pick<CodexServiceTier, 'id' | 'name'> | undefined,
  fallbackId?: string | null
): string {
  const id = tier?.id || fallbackId || '';
  const runtimeName = tier?.name?.trim();

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
