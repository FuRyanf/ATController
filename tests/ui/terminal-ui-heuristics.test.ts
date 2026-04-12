import { describe, expect, it } from 'vitest';

import { looksLikeStatefulTerminalUi } from '../../src/lib/terminalUiHeuristics';

describe('terminalUiHeuristics', () => {
  it('detects Claude fullscreen frames even when ANSI stripping collapses whitespace', () => {
    const frame =
      '\u001b[2J\u001b[H' +
      '\u001b[1mClaude\u001b[1CCode\u001b[22m\u001b[38;2;153;153;153mv2.1.101\u001b[39m\n' +
      '\u001b[38;2;153;153;153mMessage\u001b[1Cfrom\u001b[1CLinkedIn\u001b[1CClaude:\u001b[39m\n';

    expect(looksLikeStatefulTerminalUi(frame)).toBe(true);
  });

  it('does not classify ordinary shell output as stateful', () => {
    expect(looksLikeStatefulTerminalUi('~/repo$ ls -la\nsrc\npackage.json\n')).toBe(false);
  });
});
