import { describe, expect, it } from 'vitest';

import { looksLikeStatefulTerminalUi } from '../../src/lib/terminalUiHeuristics';

describe('terminalUiHeuristics', () => {
  it('detects Codex fullscreen frames even when ANSI stripping collapses whitespace', () => {
    const frame =
      '\u001b[2J\u001b[H' +
      '\u001b[1mOpenAI\u001b[1CCodex\u001b[22m\u001b[38;2;153;153;153mv0.106.0\u001b[39m\n' +
      '\u001b[38;2;153;153;153mesc\u001b[1Cto\u001b[1Cinterrupt\u001b[39m\n';

    expect(looksLikeStatefulTerminalUi(frame)).toBe(true);
  });

  it('does not classify ordinary shell output as stateful', () => {
    expect(looksLikeStatefulTerminalUi('~/repo$ ls -la\nsrc\npackage.json\n')).toBe(false);
  });
});
