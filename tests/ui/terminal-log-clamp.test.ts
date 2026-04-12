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

  it('anchors truncated fullscreen output at the latest repaint boundary', () => {
    const clear = '\u001b[2J\u001b[H';
    const frame1 = `${clear}frame one\nline two\n`;
    const frame2 = `${clear}frame two\nline four\n`;
    const text = `prefix line that should fall out\n${frame1}${frame2}`;
    const maxChars = frame1.length + frame2.length - 4;

    expect(clampTerminalLog(text, maxChars)).toBe(frame2);
  });

  it('backs up to the repaint boundary when truncation lands inside the clear sequence', () => {
    const clear = '\u001b[2J\u001b[H';
    const text = `prefix\n${clear}frame latest\n`;
    const maxChars = text.length - text.indexOf(clear) - 2;

    expect(clampTerminalLog(text, maxChars)).toBe(`${clear}frame latest\n`);
  });

  it('backs up to the latest repaint boundary when truncation lands inside the latest frame body', () => {
    const clear = '\u001b[2J\u001b[H';
    const frame1 = `${clear}frame one\nline two\n`;
    const frame2 = `${clear}frame two\nline three\nline four\n`;
    const text = `prefix line that should fall out\n${frame1}${frame2}`;
    const maxChars = frame2.length - 5;

    expect(clampTerminalLog(text, maxChars)).toBe(frame2);
  });
});
