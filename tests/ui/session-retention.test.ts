import { describe, expect, it } from 'vitest';

import { idleSessionsToRelease } from '../../src/lib/sessionRetention';

describe('Codex session retention', () => {
  it('releases the oldest inactive sessions above the idle limit', () => {
    expect(
      idleSessionsToRelease({
        sessionThreadIds: ['one', 'two', 'three', 'four', 'five', 'active'],
        activeThreadId: 'active',
        runningThreadIds: new Set(),
        lastUsedAt: { one: 1, two: 2, three: 3, four: 4, five: 5, active: 6 }
      })
    ).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('never releases the selected or running sessions', () => {
    expect(
      idleSessionsToRelease({
        sessionThreadIds: ['old-active', 'old-running', 'idle-1', 'idle-2'],
        activeThreadId: 'old-active',
        runningThreadIds: new Set(['old-running']),
        lastUsedAt: {
          'old-active': 0,
          'old-running': 0,
          'idle-1': 1,
          'idle-2': 2
        },
        maxIdleSessions: 0
      })
    ).toEqual(['idle-1', 'idle-2']);
  });
});
