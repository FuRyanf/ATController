import { describe, expect, it } from 'vitest';

import { clampTerminalLog } from '../../src/lib/terminalLogClamp';

describe('terminal log clamp', () => {
  it('returns input unchanged when within limit', () => {
    expect(clampTerminalLog('hello\nworld', 64)).toBe('hello\nworld');
  });

  it('starts from the next line boundary when truncation lands mid-line', () => {
    const text = 'line0\nline1\nline2\nline3\n';
    const clamped = clampTerminalLog(text, 11);
    expect(clamped).toBe('line3\n');
  });

  it('drops orphan OSC payloads at the beginning of truncated output', () => {
    const prefix = '0123456789ab';
    const tail = ']10;rgb:d8d8/e0e0/efef\u0007prompt';
    expect(clampTerminalLog(prefix + tail, tail.length)).toBe('prompt');
  });

  it('drops orphan CSI payloads at the beginning of truncated output', () => {
    const prefix = 'abcdefgh';
    const tail = '[31mhello';
    expect(clampTerminalLog(prefix + tail, tail.length)).toBe('hello');
  });

  it('keeps bracketed prompt text that is not a CSI fragment', () => {
    const prefix = 'abcdefgh';
    const tail = '[dev@host workspace]$ ';
    expect(clampTerminalLog(prefix + tail, tail.length)).toBe(tail);
  });
});

