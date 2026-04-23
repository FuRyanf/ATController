import { describe, expect, it } from 'vitest';

import {
  estimateTerminalStreamCacheChars,
  selectTerminalStreamCacheEvictions
} from '../../src/lib/terminalStreamCache';
import type { TerminalSessionStreamState } from '../../src/lib/terminalSessionStream';

function stream(text: string, chunks: string[] = []): TerminalSessionStreamState {
  return {
    sessionId: null,
    phase: 'ready',
    text,
    rawEndPosition: text.length,
    startPosition: 0,
    endPosition: text.length,
    chunks: chunks.map((chunk, index) => ({
      rawStartPosition: index,
      rawEndPosition: index + chunk.length,
      startPosition: index,
      endPosition: index + chunk.length,
      data: chunk
    })),
    resetToken: 0
  };
}

describe('terminal stream cache', () => {
  it('estimates retained text plus replay chunks', () => {
    expect(estimateTerminalStreamCacheChars(stream('abcd', ['ef', 'ghi']))).toBe(9);
  });

  it('evicts least-recently-used unprotected streams until within limits', () => {
    const evictions = selectTerminalStreamCacheEvictions(
      [
        { threadId: 'selected', stream: stream('x'.repeat(10)), lastAccessedAtMs: 1, isProtected: true },
        { threadId: 'old', stream: stream('x'.repeat(10)), lastAccessedAtMs: 2, isProtected: false },
        { threadId: 'middle', stream: stream('x'.repeat(10)), lastAccessedAtMs: 3, isProtected: false },
        { threadId: 'new', stream: stream('x'.repeat(10)), lastAccessedAtMs: 4, isProtected: false }
      ],
      { maxThreads: 2, maxChars: 25 }
    );

    expect(evictions).toEqual(['old', 'middle']);
  });

  it('keeps protected streams even when they exceed the cache budget', () => {
    const evictions = selectTerminalStreamCacheEvictions(
      [
        { threadId: 'active-a', stream: stream('x'.repeat(50)), lastAccessedAtMs: 1, isProtected: true },
        { threadId: 'active-b', stream: stream('x'.repeat(50)), lastAccessedAtMs: 2, isProtected: true }
      ],
      { maxThreads: 1, maxChars: 10 }
    );

    expect(evictions).toEqual([]);
  });
});
