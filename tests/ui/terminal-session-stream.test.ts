import { describe, expect, it } from 'vitest';

import {
  appendTerminalStreamChunk,
  bindLiveTerminalSessionStream,
  bindTerminalSessionStream,
  createTerminalSessionStreamState,
  hydrateTerminalSessionStream,
  presentTerminalSnapshot,
  terminalSessionStreamKnownRawEndPosition
} from '../../src/lib/terminalSessionStream';

describe('terminalSessionStream', () => {
  it('binds a new session in hydrating mode and clears prior terminal state', () => {
    const previous = presentTerminalSnapshot(
      createTerminalSessionStreamState(),
      {
        text: 'stale output',
        startPosition: 0,
        endPosition: 12,
        truncated: false
      },
      1_000
    );

    expect(bindTerminalSessionStream(previous, 'session-1')).toEqual({
      sessionId: 'session-1',
      phase: 'hydrating',
      text: '',
      rawEndPosition: 0,
      startPosition: 0,
      endPosition: 0,
      chunks: [],
      resetToken: previous.resetToken + 1
    });
  });

  it('binds live-only sessions in ready mode so chunks render immediately', () => {
    expect(bindLiveTerminalSessionStream(createTerminalSessionStreamState(), 'session-1')).toEqual({
      sessionId: 'session-1',
      phase: 'ready',
      text: '',
      rawEndPosition: 0,
      startPosition: 0,
      endPosition: 0,
      chunks: [],
      resetToken: 1
    });
  });

  it('buffers live chunks while hydration is pending', () => {
    const state = bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1');

    const next = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 5,
        endPosition: 9,
        data: 'tail'
      },
      1_000
    );

    expect(next.phase).toBe('hydrating');
    expect(next.text).toBe('');
    expect(next.chunks).toEqual([
      {
        rawStartPosition: 5,
        rawEndPosition: 9,
        startPosition: 0,
        endPosition: 4,
        data: 'tail'
      }
    ]);
    expect(terminalSessionStreamKnownRawEndPosition(next)).toBe(9);
  });

  it('keeps the non-overlapping tail when buffered chunks partially overlap', () => {
    let state = bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1');
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 0,
        endPosition: 10,
        data: 'abcdefghij'
      },
      1_000
    );
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 7,
        endPosition: 15,
        data: 'hijklmno'
      },
      1_000
    );

    const hydrated = hydrateTerminalSessionStream(
      state,
      'session-1',
      {
        text: 'abcdefghij',
        startPosition: 0,
        endPosition: 10,
        truncated: false
      },
      1_000
    );

    expect(hydrated.text).toBe('abcdefghijklmno');
    expect(hydrated.rawEndPosition).toBe(15);
    expect(hydrated.chunks).toEqual([
      {
        rawStartPosition: 10,
        rawEndPosition: 15,
        startPosition: 10,
        endPosition: 15,
        data: 'klmno'
      }
    ]);
  });

  it('hydrates from a snapshot and replays only buffered chunks beyond the snapshot boundary', () => {
    let state = bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1');
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 5,
        endPosition: 9,
        data: 'tail'
      },
      1_000
    );
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 9,
        endPosition: 12,
        data: '+++' 
      },
      1_000
    );

    const hydrated = hydrateTerminalSessionStream(
      state,
      'session-1',
      {
        text: 'hello tail',
        startPosition: 0,
        endPosition: 9,
        truncated: false
      },
      1_000
    );

    expect(hydrated.phase).toBe('ready');
    expect(hydrated.text).toBe('hello tail+++');
    expect(hydrated.rawEndPosition).toBe(12);
    expect(hydrated.endPosition).toBe(12);
    expect(hydrated.chunks).toEqual([
      {
        rawStartPosition: 9,
        rawEndPosition: 12,
        startPosition: 9,
        endPosition: 12,
        data: '+++'
      }
    ]);
  });

  it('trims a buffered chunk when hydration lands in the middle of it', () => {
    let state = bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1');
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 5,
        endPosition: 12,
        data: '1234567'
      },
      1_000
    );

    const hydrated = hydrateTerminalSessionStream(
      state,
      'session-1',
      {
        text: 'abcde123',
        startPosition: 0,
        endPosition: 8,
        truncated: false
      },
      1_000
    );

    expect(hydrated.phase).toBe('ready');
    expect(hydrated.text).toBe('abcde1234567');
    expect(hydrated.rawEndPosition).toBe(12);
    expect(hydrated.startPosition).toBe(0);
    expect(hydrated.endPosition).toBe(12);
    expect(hydrated.chunks).toEqual([
      {
        rawStartPosition: 8,
        rawEndPosition: 12,
        startPosition: 8,
        endPosition: 12,
        data: '4567'
      }
    ]);
  });

  it('rewinds to the repaint boundary when hydration lands inside a fullscreen repaint chunk', () => {
    const clear = '\u001b[2J\u001b[H';
    const frame = `${clear}Claude Code\nfresh frame\n`;
    let state = bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1');
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 0,
        endPosition: frame.length,
        data: frame
      },
      1_000
    );

    const hydrated = hydrateTerminalSessionStream(
      state,
      'session-1',
      {
        text: 'stale visible snapshot',
        startPosition: 0,
        endPosition: clear.length + 5,
        truncated: false
      },
      1_000
    );

    expect(hydrated.phase).toBe('ready');
    expect(hydrated.text).toBe(frame);
    expect(hydrated.startPosition).toBe(0);
    expect(hydrated.endPosition).toBe(frame.length);
    expect(hydrated.rawEndPosition).toBe(frame.length);
    expect(hydrated.chunks).toEqual([]);
  });

  it('replaces the snapshot with a later buffered repaint chunk during hydration', () => {
    const clear = '\u001b[2J\u001b[H';
    const frame1 = `${clear}Claude Code\nframe one\n`;
    const frame2 = `${clear}Claude Code\nframe two\n`;
    let state = bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1');
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: frame1.length,
        endPosition: frame1.length + frame2.length,
        data: frame2
      },
      1_000
    );

    const hydrated = hydrateTerminalSessionStream(
      state,
      'session-1',
      {
        text: frame1,
        startPosition: 0,
        endPosition: frame1.length,
        truncated: false
      },
      1_000
    );

    expect(hydrated.phase).toBe('ready');
    expect(hydrated.text).toBe(frame2);
    expect(hydrated.startPosition).toBe(frame1.length);
    expect(hydrated.endPosition).toBe(frame1.length + frame2.length);
    expect(hydrated.rawEndPosition).toBe(frame1.length + frame2.length);
    expect(hydrated.chunks).toEqual([]);
  });

  it('ignores stale or duplicate chunks once the stream is ready', () => {
    const ready = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: 'hello',
        startPosition: 0,
        endPosition: 5,
        truncated: false
      },
      1_000
    );

    const duplicate = appendTerminalStreamChunk(
      ready,
      {
        sessionId: 'session-1',
        startPosition: 0,
        endPosition: 5,
        data: 'hello'
      },
      1_000
    );

    expect(duplicate).toEqual(ready);
    expect(terminalSessionStreamKnownRawEndPosition(ready)).toBe(5);
  });

  it('does not force a reset for an identical ready snapshot', () => {
    const ready = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: 'hello',
        startPosition: 0,
        endPosition: 5,
        truncated: false
      },
      1_000
    );

    const next = presentTerminalSnapshot(
      ready,
      {
        text: 'hello',
        startPosition: 0,
        endPosition: 5,
        truncated: false
      },
      1_000
    );

    expect(next).toBe(ready);
  });

  it('preserves the latest fullscreen repaint boundary when snapshot text is truncated', () => {
    const clear = '\u001b[2J\u001b[H';
    const frame1 = `${clear}frame one\nline two\n`;
    const frame2 = `${clear}frame two\nline four\n`;
    const snapshotText = `prefix line that should fall out\n${frame1}${frame2}`;
    const maxChars = frame1.length + frame2.length - 4;
    const expectedStart = snapshotText.lastIndexOf(frame2);

    const next = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: snapshotText,
        startPosition: 0,
        endPosition: snapshotText.length,
        truncated: false
      },
      maxChars
    );

    expect(next.text).toBe(frame2);
    expect(next.startPosition).toBe(expectedStart);
    expect(next.endPosition).toBe(snapshotText.length);
  });

  it('backs up to the latest repaint boundary when snapshot truncation lands inside the latest frame body', () => {
    const clear = '\u001b[2J\u001b[H';
    const frame1 = `${clear}frame one\nline two\n`;
    const frame2 = `${clear}frame two\nline three\nline four\n`;
    const snapshotText = `prefix line that should fall out\n${frame1}${frame2}`;
    const maxChars = frame2.length - 5;
    const expectedStart = snapshotText.lastIndexOf(frame2);

    const next = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: snapshotText,
        startPosition: 0,
        endPosition: snapshotText.length,
        truncated: false
      },
      maxChars
    );

    expect(next.text).toBe(frame2);
    expect(next.startPosition).toBe(expectedStart);
    expect(next.endPosition).toBe(snapshotText.length);
  });

  it('drops orphan CSI fragments when a snapshot window starts in the middle of a control sequence', () => {
    const snapshotText = 'abcdefgh[31mhello';

    const next = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: snapshotText,
        startPosition: 0,
        endPosition: snapshotText.length,
        truncated: false
      },
      '[31mhello'.length
    );

    expect(next.text).toBe('hello');
    expect(next.startPosition).toBe(snapshotText.length - 'hello'.length);
  });

  it('preserves a nonzero snapshot start position when presenting a ready stream', () => {
    const clear = '\u001b[2J\u001b[H';
    const snapshotText = `${clear}Claude Code\nframe two\n`;
    const next = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: snapshotText,
        startPosition: 512,
        endPosition: 512 + snapshotText.length,
        truncated: false
      },
      1_000
    );

    expect(next.text).toBe(snapshotText);
    expect(next.startPosition).toBe(512);
    expect(next.endPosition).toBe(512 + snapshotText.length);
    expect(next.rawEndPosition).toBe(512 + snapshotText.length);
  });

  it('ignores stale snapshots once a ready stream has advanced beyond them', () => {
    let state = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: 'hello',
        startPosition: 0,
        endPosition: 5,
        truncated: false
      },
      1_000
    );

    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 5,
        endPosition: 8,
        data: '!!!'
      },
      1_000
    );

    const stale = presentTerminalSnapshot(
      state,
      {
        text: 'hello',
        startPosition: 0,
        endPosition: 5,
        truncated: false
      },
      1_000
    );

    expect(stale).toBe(state);
  });

  it('appends ordered live chunks and trims the visible window without losing raw ordering', () => {
    let state = presentTerminalSnapshot(
      bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-1'),
      {
        text: 'abcd',
        startPosition: 0,
        endPosition: 4,
        truncated: false
      },
      6
    );

    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 4,
        endPosition: 6,
        data: 'ef'
      },
      6
    );
    state = appendTerminalStreamChunk(
      state,
      {
        sessionId: 'session-1',
        startPosition: 6,
        endPosition: 8,
        data: 'gh'
      },
      6
    );

    expect(state.text).toBe('cdefgh');
    expect(state.startPosition).toBe(2);
    expect(state.endPosition).toBe(8);
    expect(state.rawEndPosition).toBe(8);
    expect(state.chunks).toEqual([
      {
        rawStartPosition: 4,
        rawEndPosition: 6,
        startPosition: 4,
        endPosition: 6,
        data: 'ef'
      },
      {
        rawStartPosition: 6,
        rawEndPosition: 8,
        startPosition: 6,
        endPosition: 8,
        data: 'gh'
      }
    ]);
  });

  it('drops chunks for stale sessions after a rebind', () => {
    const rebound = bindTerminalSessionStream(createTerminalSessionStreamState(), 'session-2');

    expect(
      appendTerminalStreamChunk(
        rebound,
        {
          sessionId: 'session-1',
          startPosition: 0,
          endPosition: 4,
          data: 'late'
        },
        1_000
      )
    ).toEqual(rebound);
  });
});
