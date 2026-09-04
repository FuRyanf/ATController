import type { CodexRateLimitWindowV2 } from '../types';

const SECONDS_TIMESTAMP_CUTOFF = 100_000_000_000;

export interface UsageTimeFormatOptions {
  locale?: string;
  timeZone?: string;
  now?: number;
}

export function usageRemainingPercent(
  window?: CodexRateLimitWindowV2 | null
): number | null {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

export function formatUsageRemaining(
  window?: CodexRateLimitWindowV2 | null
): string {
  const remaining = usageRemainingPercent(window);
  return remaining == null ? '—' : `${remaining}% left`;
}

export function usageResetDate(resetsAt?: number | null): Date | null {
  if (resetsAt == null || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return null;
  }
  const milliseconds =
    resetsAt < SECONDS_TIMESTAMP_CUTOFF ? resetsAt * 1_000 : resetsAt;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatUsageResetCountdown(
  resetsAt?: number | null,
  now = Date.now()
): string | null {
  const resetDate = usageResetDate(resetsAt);
  if (!resetDate) return null;
  const remainingMinutes = Math.ceil((resetDate.getTime() - now) / 60_000);
  if (remainingMinutes <= 0) return 'reset due now';
  if (remainingMinutes < 60) return `in ${remainingMinutes}m`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours < 24) return `in ${hours}h${minutes ? ` ${minutes}m` : ''}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `in ${days}d${remainingHours ? ` ${remainingHours}h` : ''}`;
}

export function formatUsageReset(
  window?: CodexRateLimitWindowV2 | null,
  options: UsageTimeFormatOptions = {}
): string {
  const resetDate = usageResetDate(window?.resetsAt);
  if (!resetDate) return 'Reset time unavailable';
  const exact = new Intl.DateTimeFormat(options.locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(options.timeZone ? { timeZone: options.timeZone } : {})
  }).format(resetDate);
  const countdown = formatUsageResetCountdown(
    window?.resetsAt,
    options.now ?? Date.now()
  );
  return `Resets ${exact}${countdown ? ` · ${countdown}` : ''}`;
}
