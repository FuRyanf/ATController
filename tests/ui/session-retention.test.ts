import { describe, expect, it } from 'vitest';

import {
  currentRunningTurn,
  idleSessionsToRelease,
  isThreadRunning,
  shouldSweepSessionRetention
} from '../../src/lib/sessionRetention';

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

  it('does not let a stale historical turn pin an idle session', () => {
    const thread = {
      turns: [
        { id: 'stale', status: 'inProgress' },
        { id: 'latest', status: 'completed' }
      ]
    };

    expect(currentRunningTurn(thread)).toBeUndefined();
    expect(isThreadRunning({ ...thread, status: 'idle' })).toBe(false);
    expect(
      currentRunningTurn({
        turns: [...thread.turns, { id: 'active', status: 'inProgress' }]
      })?.id
    ).toBe('active');
    expect(isThreadRunning({ ...thread, status: 'active' })).toBe(true);
  });

  it('retries retention when Codex publishes the post-turn idle status', () => {
    expect(shouldSweepSessionRetention('turnCompleted', 'completed')).toBe(true);
    expect(shouldSweepSessionRetention('threadStatusChanged', 'idle')).toBe(true);
    expect(shouldSweepSessionRetention('threadStatusChanged', 'active')).toBe(false);
  });
});
