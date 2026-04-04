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
    expect(hydrated.endPosition).toBe(13);
    expect(hydrated.chunks).toEqual([
      {
        rawStartPosition: 9,
        rawEndPosition: 12,
        startPosition: 10,
        endPosition: 13,
        data: '+++'
      }
    ]);
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
