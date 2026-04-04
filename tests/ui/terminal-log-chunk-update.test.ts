import { describe, expect, it } from 'vitest';

import { resolveAppendedTerminalLogChunk } from '../../src/lib/terminalLogChunkUpdate';

describe('terminal log chunk updates', () => {
  it('treats a plain append as incremental', () => {
    expect(
      resolveAppendedTerminalLogChunk({
        previousText: 'abc',
        chunk: 'def',
        maxChars: 16,
        present: (combined) => combined
      })
    ).toEqual({
      nextText: 'abcdef',
      requiresSnapshot: false
    });
  });

  it('treats prefix clamp rollover as incremental', () => {
    expect(
      resolveAppendedTerminalLogChunk({
        previousText: 'abcdef',
        chunk: 'gh',
        maxChars: 6,
        present: (combined) => combined.slice(combined.length - 6)
      })
    ).toEqual({
      nextText: 'cdefgh',
      requiresSnapshot: false
    });
  });

  it('requires a snapshot when presentation mutates more than the clamped prefix', () => {
    expect(
      resolveAppendedTerminalLogChunk({
        previousText: 'abcdef',
        chunk: 'gh',
        maxChars: 6,
        present: () => 'abXYgh'
      })
    ).toEqual({
      nextText: 'abXYgh',
      requiresSnapshot: true
    });
  });
});
