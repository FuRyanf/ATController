import { describe, expect, it } from 'vitest';

import {
  formatUsageRemaining,
  formatUsageReset,
  formatUsageResetCountdown,
  usageRemainingPercent,
  usageResetDate
} from '../../src/lib/usage';

describe('Codex usage formatting', () => {
  it('clamps remaining allowance and handles unavailable limits', () => {
    expect(usageRemainingPercent({ usedPercent: 27.6 })).toBe(72);
    expect(usageRemainingPercent({ usedPercent: 140 })).toBe(0);
    expect(usageRemainingPercent({ usedPercent: -10 })).toBe(100);
    expect(formatUsageRemaining(null)).toBe('—');
  });

  it('accepts Codex reset timestamps in seconds or milliseconds', () => {
    expect(usageResetDate(1_786_048_200)?.getTime()).toBe(1_786_048_200_000);
    expect(usageResetDate(1_786_048_200_000)?.getTime()).toBe(
      1_786_048_200_000
    );
  });

  it('shows an exact local reset time and a useful countdown', () => {
    const reset = { usedPercent: 20, resetsAt: 1_786_048_200 };
    expect(
      formatUsageReset(reset, {
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
        now: 1_786_040_100_000
      })
    ).toMatch(/^Resets .*2026.*PDT · in 2h 15m$/);
    expect(formatUsageResetCountdown(reset.resetsAt, 1_786_048_140_000)).toBe(
      'in 1m'
    );
    expect(formatUsageReset({ usedPercent: 20 })).toBe(
      'Reset time unavailable'
    );
  });
});
