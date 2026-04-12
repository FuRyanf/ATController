import { describe, expect, it, vi } from 'vitest';

import {
  presentTerminalEventData,
  presentTerminalWindow,
  presentTerminalText,
  shouldPreserveRawTerminalPresentation
} from '../../src/lib/terminalOutputPresentation';

describe('terminal output presentation', () => {
  it('preserves raw snapshots when the incoming text looks stateful', () => {
    const raw = '\u001b[?1049h\u001b[2J\u001b[HClaude Code\nscreen body\n';
    const stripHiddenPrompts = vi.fn((text: string) => text.replace('Claude Code', ''));

    const next = presentTerminalText(raw, {
      currentText: '',
      maxChars: 10_000,
      stripHiddenPrompts
    });

    expect(next).toBe('\u001b[2J\u001b[HClaude Code\nscreen body\n');
    expect(stripHiddenPrompts).not.toHaveBeenCalled();
  });

  it('preserves raw event data when the current stream already looks stateful', () => {
    const rawEvent = '\u001b[12AReading 1 file…';
    const stripHiddenPrompts = vi.fn((text: string) => text.replace('Reading', ''));

    const next = presentTerminalEventData(rawEvent, {
      currentText: '\u001b[?1049h\u001b[2J\u001b[HClaude Code\nscreen body\n',
      stripHiddenPrompts
    });

    expect(next).toBe(rawEvent);
    expect(stripHiddenPrompts).not.toHaveBeenCalled();
  });

  it('still strips hidden prompts for plain terminal text', () => {
    const stripHiddenPrompts = vi.fn((text: string) => text.replace('secret prompt', ''));

    const next = presentTerminalText('hello\nsecret prompt\nworld\n', {
      currentText: '',
      maxChars: 10_000,
      stripHiddenPrompts
    });

    expect(next).toBe('hello\n\nworld\n');
    expect(stripHiddenPrompts).toHaveBeenCalledOnce();
  });

  it('treats previous stateful content as enough to preserve raw presentation', () => {
    expect(
      shouldPreserveRawTerminalPresentation(
        'plain follow-up chunk',
        '\u001b[?1049h\u001b[2J\u001b[HClaude Code\nscreen body\n'
      )
    ).toBe(true);
  });

  it('collapses repeated fullscreen snapshots to the latest frame even when the log is under the clamp limit', () => {
    const clear = '\u001b[2J\u001b[H';
    const frame1 = `${clear}Claude Code\nframe one\n`;
    const frame2 = `${clear}Claude Code\nframe two\n`;
    const raw = `${frame1}${frame2}`;

    const next = presentTerminalWindow(raw, {
      currentText: '',
      maxChars: 10_000
    });

    expect(next.preserveRaw).toBe(true);
    expect(next.text).toBe(frame2);
    expect(next.startOffset).toBe(raw.lastIndexOf(frame2));
  });
});
