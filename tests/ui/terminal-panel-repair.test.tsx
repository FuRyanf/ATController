import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DECTCEM_HIDE = '\u001b[?25l';
const DECTCEM_SHOW = '\u001b[?25h';
const MULTILINE_ENTER_SEQUENCE = '\x1b\r';

let resizeObserverCallback: ResizeObserverCallback | null = null;

const mocks = vi.hoisted(() => {
  const fit = vi.fn();
  const proposedDimensions = { cols: 80, rows: 24 };
  const createSearchAddon = () => ({
    activate: vi.fn(),
    dispose: vi.fn(),
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearDecorations: vi.fn(),
    clearActiveDecoration: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() }))
  });
  const terminals: Array<{
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    onKey: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onScroll: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
    scrollToLine: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    screenLines: string[];
    wrappedRows: Set<number>;
    isUserScrolling: boolean;
    onKeyListeners: Set<(event: { key: string; domEvent: KeyboardEvent }) => void>;
    onDataListeners: Set<(data: string) => void>;
    onScrollListeners: Set<(viewportY: number) => void>;
    buffer: {
      active: {
        baseY: number;
        viewportY: number;
        cursorX: number;
        cursorY: number;
        length: number;
        getLine: (row: number) => { isWrapped: boolean; translateToString: (trimRight?: boolean) => string } | undefined;
      };
    };
  }> = [];

  const emitScroll = (term: (typeof terminals)[number]) => {
    for (const listener of term.onScrollListeners) {
      listener(term.buffer.active.viewportY);
    }
  };

  const emitData = (term: (typeof terminals)[number], data: string) => {
    for (const listener of term.onDataListeners) {
      listener(data);
    }
  };

  const emitKey = (
    term: (typeof terminals)[number],
    key: string,
    domEventInit: KeyboardEventInit = {}
  ) => {
    const domEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      ...domEventInit
    });
    for (const listener of term.onKeyListeners) {
      listener({ key, domEvent });
    }
  };

  const syncBufferState = (term: (typeof terminals)[number]) => {
    const lineCount = Math.max(1, term.screenLines.length);
    const previousBaseY = term.buffer.active.baseY;
    const previousViewportY = term.buffer.active.viewportY;
    term.buffer.active.length = lineCount;
    term.buffer.active.baseY = Math.max(0, lineCount - term.rows);
    term.buffer.active.cursorY = Math.max(0, Math.min(term.rows - 1, lineCount - 1 - term.buffer.active.baseY));
    if (term.isUserScrolling || previousViewportY < previousBaseY) {
      term.buffer.active.viewportY = Math.min(previousViewportY, term.buffer.active.baseY);
    } else {
      term.buffer.active.viewportY = term.buffer.active.baseY;
    }
    term.isUserScrolling = term.buffer.active.viewportY < term.buffer.active.baseY;
  };

  const writePrintableChunk = (term: (typeof terminals)[number], chunk: string) => {
    if (term.screenLines.length === 0) {
      term.screenLines.push('');
    }

    let absoluteRow = term.buffer.active.baseY + term.buffer.active.cursorY;
    let cursorX = term.buffer.active.cursorX;

    const ensureRow = (row: number) => {
      while (term.screenLines.length <= row) {
        term.screenLines.push('');
      }
    };

    const writeChar = (char: string) => {
      ensureRow(absoluteRow);
      const current = term.screenLines[absoluteRow] ?? '';
      const padded = cursorX > current.length ? current.padEnd(cursorX, ' ') : current;
      if (cursorX >= padded.length) {
        term.screenLines[absoluteRow] = `${padded}${char}`;
      } else {
        term.screenLines[absoluteRow] = `${padded.slice(0, cursorX)}${char}${padded.slice(cursorX + 1)}`;
      }
      cursorX += 1;
    };

    for (const char of chunk) {
      if (char === '\n') {
        absoluteRow += 1;
        cursorX = 0;
        ensureRow(absoluteRow);
        continue;
      }
      if (char === '\r') {
        cursorX = 0;
        continue;
      }
      if (char === '\u001b') {
        continue;
      }
      writeChar(char);
    }

    term.buffer.active.cursorX = cursorX;
    syncBufferState(term);
    const nextAbsoluteRow = Math.max(0, term.screenLines.length - 1);
    term.buffer.active.cursorY = Math.max(0, Math.min(term.rows - 1, nextAbsoluteRow - term.buffer.active.baseY));
  };

  const createTerminal = () => {
    const term = {
      open: vi.fn((host: HTMLElement) => {
        const root = document.createElement('div');
        root.className = 'xterm';
        const textarea = document.createElement('textarea');
        textarea.className = 'xterm-helper-textarea';
        const viewport = document.createElement('div');
        viewport.className = 'xterm-viewport';
        const screen = document.createElement('div');
        screen.className = 'xterm-screen';
        const canvas = document.createElement('canvas');
        screen.appendChild(canvas);
        root.addEventListener('wheel', (event) => {
          const direction = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0;
          if (direction === 0) {
            return;
          }
          const nextViewportY = Math.max(
            0,
            Math.min(term.buffer.active.baseY, term.buffer.active.viewportY + direction)
          );
          if (nextViewportY === term.buffer.active.viewportY) {
            return;
          }
          term.buffer.active.viewportY = nextViewportY;
          term.isUserScrolling = nextViewportY < term.buffer.active.baseY;
          emitScroll(term);
        });
        root.appendChild(textarea);
        root.appendChild(viewport);
        root.appendChild(screen);
        host.appendChild(root);
      }),
      loadAddon: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onKeyListeners: new Set<(event: { key: string; domEvent: KeyboardEvent }) => void>(),
      onKey: vi.fn((listener: (event: { key: string; domEvent: KeyboardEvent }) => void) => {
        term.onKeyListeners.add(listener);
        return {
          dispose: vi.fn(() => {
            term.onKeyListeners.delete(listener);
          })
        };
      }),
      onDataListeners: new Set<(data: string) => void>(),
      onData: vi.fn((listener: (data: string) => void) => {
        term.onDataListeners.add(listener);
        return {
          dispose: vi.fn(() => {
            term.onDataListeners.delete(listener);
          })
        };
      }),
      onScrollListeners: new Set<(viewportY: number) => void>(),
      onScroll: vi.fn((listener: (viewportY: number) => void) => {
        term.onScrollListeners.add(listener);
        return {
          dispose: vi.fn(() => {
            term.onScrollListeners.delete(listener);
          })
        };
      }),
      write: vi.fn((chunk: string, callback?: () => void) => {
        const previousBaseY = term.buffer.active.baseY;
        const previousViewportY = term.buffer.active.viewportY;
        const cursorMove = /^\u001b\[(\d+);(\d+)H$/.exec(chunk);
        if (cursorMove) {
          term.buffer.active.cursorY = Math.max(0, Number(cursorMove[1]) - 1);
          term.buffer.active.cursorX = Math.max(0, Number(cursorMove[2]) - 1);
          callback?.();
          return;
        }
        writePrintableChunk(term, chunk);
        if (term.buffer.active.baseY !== previousBaseY || term.buffer.active.viewportY !== previousViewportY) {
          emitScroll(term);
        }
        callback?.();
      }),
      refresh: vi.fn(),
      reset: vi.fn(() => {
        term.screenLines = [''];
        term.wrappedRows.clear();
        term.buffer.active.cursorX = 0;
        term.isUserScrolling = false;
        syncBufferState(term);
        emitScroll(term);
      }),
      resize: vi.fn((cols: number, rows: number) => {
        const previousViewportY = term.buffer.active.viewportY;
        term.cols = cols;
        term.rows = rows;
        syncBufferState(term);
        if (term.buffer.active.viewportY !== previousViewportY) {
          emitScroll(term);
        }
      }),
      scrollToBottom: vi.fn(() => {
        if (term.buffer.active.viewportY === term.buffer.active.baseY) {
          return;
        }
        term.buffer.active.viewportY = term.buffer.active.baseY;
        term.isUserScrolling = false;
        emitScroll(term);
      }),
      scrollToLine: vi.fn((line: number) => {
        const nextViewportY = Math.max(0, Math.min(line, term.buffer.active.baseY));
        if (nextViewportY === term.buffer.active.viewportY) {
          return;
        }
        term.buffer.active.viewportY = nextViewportY;
        term.isUserScrolling = nextViewportY < term.buffer.active.baseY;
        emitScroll(term);
      }),
      focus: vi.fn(),
      dispose: vi.fn(),
      options: {},
      cols: 80,
      rows: 24,
      screenLines: [''],
      wrappedRows: new Set<number>(),
      isUserScrolling: false,
      buffer: {
        active: {
          baseY: 0,
          viewportY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: (row: number) => {
            const value = term.screenLines[row];
            if (typeof value !== 'string') {
              return undefined;
            }
            return {
              isWrapped: term.wrappedRows.has(row),
              translateToString: (trimRight?: boolean) => (trimRight ? value.replace(/\s+$/u, '') : value)
            };
          }
        }
      }
    };
    syncBufferState(term);
    terminals.push(term);
    return term;
  };

  return {
    createTerminal,
    createSearchAddon,
    emitData,
    emitKey,
    fit,
    proposedDimensions,
    terminals
  };
});

vi.mock('../../src/lib/api', () => ({
  api: {
    openExternalUrl: vi.fn(async () => undefined)
  }
}));

vi.mock('xterm', () => ({
  Terminal: vi.fn((options: Record<string, unknown> = {}) => {
    const term = mocks.createTerminal();
    term.options = { ...options };
    return term;
  })
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: mocks.fit,
    proposeDimensions: () => {
      mocks.fit();
      return mocks.proposedDimensions;
    },
    dispose: vi.fn()
  }))
}));

vi.mock('xterm-addon-web-links', () => ({
  WebLinksAddon: vi.fn(() => ({}))
}));

vi.mock('xterm-addon-search', () => ({
  SearchAddon: vi.fn(() => mocks.createSearchAddon())
}));

import { TerminalPanel } from '../../src/components/TerminalPanel';

function buildStreamState(
  text: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    sessionId: 'session-1',
    phase: 'ready' as const,
    text,
    rawEndPosition: text.length,
    startPosition: 0,
    endPosition: text.length,
    chunks: [],
    resetToken: 1,
    ...overrides
  };
}

function renderLivePanel(
  text: string,
  options: {
    streamState?: Record<string, unknown>;
    props?: Record<string, unknown>;
  } = {}
) {
  const streamState = buildStreamState(text, options.streamState);
  return render(
    <TerminalPanel
      sessionId="session-1"
      streamState={streamState}
      content={text}
      readOnly={false}
      inputEnabled
      cursorVisible={false}
      focusRequestId={0}
      repairRequestId={0}
      searchToggleRequestId={0}
      onData={() => undefined}
      onResize={() => undefined}
      onFocusChange={() => undefined}
      {...options.props}
    />
  );
}

function renderLegacyPanel(
  text: string,
  options: {
    streamState?: Record<string, unknown>;
    props?: Record<string, unknown>;
  } = {}
) {
  const streamState = buildStreamState(text, options.streamState);
  return render(
    <TerminalPanel
      sessionId={null}
      streamState={streamState}
      content={text}
      readOnly={false}
      inputEnabled
      cursorVisible={false}
      focusRequestId={0}
      repairRequestId={0}
      searchToggleRequestId={0}
      onData={() => undefined}
      onResize={() => undefined}
      onFocusChange={() => undefined}
      {...options.props}
    />
  );
}

function setViewportMetrics(
  viewport: HTMLElement,
  {
    clientHeight,
    scrollHeight,
    scrollTop
  }: {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
  }
) {
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    value: clientHeight
  });
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    value: scrollHeight
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    writable: true,
    value: scrollTop
  });
}

function setDefaultScrollbackViewport(viewport: HTMLElement, scrollTop = 900) {
  // With clientHeight=200 and scrollHeight=1200, scrollTop=900 is 100px off bottom.
  setViewportMetrics(viewport, {
    clientHeight: 200,
    scrollHeight: 1200,
    scrollTop
  });
}

async function pauseFollowByWheelScroll(viewport: HTMLElement) {
  await act(async () => {
    fireEvent.wheel(viewport, { deltaY: -32 });
    fireEvent.scroll(viewport);
    await Promise.resolve();
  });
}

describe('TerminalPanel live rendering', () => {
  beforeEach(() => {
    (globalThis as { __ATCONTROLLER_ENABLE_XTERM_TESTS__?: boolean }).__ATCONTROLLER_ENABLE_XTERM_TESTS__ = true;
    mocks.fit.mockClear();
    mocks.proposedDimensions.cols = 80;
    mocks.proposedDimensions.rows = 24;
    mocks.terminals.length = 0;
    resizeObserverCallback = null;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as typeof ResizeObserver;
  });

  afterEach(() => {
    delete (globalThis as { __ATCONTROLLER_ENABLE_XTERM_TESTS__?: boolean }).__ATCONTROLLER_ENABLE_XTERM_TESTS__;
  });

  it('renders completed Claude snapshots in a plain scrollback view when no session is active', () => {
    const snapshotText = '\u001b[2JClaude Code\r\nframe one\r\nframe two\r\n';
    const { container } = render(
      <TerminalPanel
        sessionId={null}
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: snapshotText,
          startPosition: 0,
          endPosition: snapshotText.length,
          rawEndPosition: snapshotText.length,
          chunks: [],
          resetToken: 1
        }}
      />
    );

    expect(container.querySelector('.xterm-viewport')).toBeNull();
    const fallback = container.querySelector('.terminal-fallback');
    expect(fallback?.textContent).toContain('Claude Code');
    expect(fallback?.textContent).toContain('frame one');
    expect(fallback?.textContent).toContain('frame two');
  });

  it('keeps non-stateful historical output on xterm when no session is active', async () => {
    const snapshotText = 'plain shell output\nsecond line\n';
    const { container } = render(
      <TerminalPanel
        sessionId={null}
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: snapshotText,
          startPosition: 0,
          endPosition: snapshotText.length,
          rawEndPosition: snapshotText.length,
          chunks: [],
          resetToken: 1
        }}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    expect(container.querySelector('.xterm-viewport')).not.toBeNull();
  });

  it('immediately replays the latest live snapshot on mount', async () => {
    const initialContent = '\u001b[?1049hClaude Code v2.1.101\nWhirlpooling...';
    renderLivePanel(initialContent, {
      props: { preferLiveRedrawOnMount: true }
    });

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });
  });

  it('appends streamed chunks without resetting the live xterm buffer', async () => {
    const { rerender } = renderLivePanel('abc');

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('abc', expect.any(Function));
    });

    term.write.mockClear();
    term.reset.mockClear();

    const nextText = 'abcdef';
    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextText, {
          rawEndPosition: 6,
          endPosition: 6,
          chunks: [
            {
              rawStartPosition: 3,
              rawEndPosition: 6,
              startPosition: 3,
              endPosition: 6,
              data: 'def'
            }
          ]
        })}
        content={nextText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('def', expect.any(Function));
      expect(term.reset).not.toHaveBeenCalled();
    });
  });

  it('appends stateful live chunks without replaying the whole terminal snapshot', async () => {
    const initialText = '\u001b[?1049hClaude Code\nframe one';
    const nextText = `${initialText}\nframe two`;
    const { rerender } = renderLivePanel(initialText);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialText, expect.any(Function));
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextText, {
          rawEndPosition: nextText.length,
          endPosition: nextText.length,
          chunks: [
            {
              rawStartPosition: initialText.length,
              rawEndPosition: nextText.length,
              startPosition: initialText.length,
              endPosition: nextText.length,
              data: '\nframe two'
            }
          ]
        })}
        content={nextText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nframe two', expect.any(Function));
      expect(term.reset).not.toHaveBeenCalled();
    });
  });

  it('replays the visible suffix instead of resetting when the visible window trims ahead', async () => {
    const initialStreamState = buildStreamState('abcdef', {
      rawEndPosition: 6,
      endPosition: 6,
      resetToken: 1
    });
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={initialStreamState}
        content={initialStreamState.text}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('abcdef', expect.any(Function));
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState('cdefghij', {
          rawEndPosition: 10,
          startPosition: 2,
          endPosition: 10,
          chunks: [
            {
              rawStartPosition: 8,
              rawEndPosition: 10,
              startPosition: 8,
              endPosition: 10,
              data: 'ij'
            }
          ],
          resetToken: 1
        })}
        content="cdefghij"
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('ghij', expect.any(Function));
      expect(term.reset).not.toHaveBeenCalled();
    });
  });

  it('hides the xterm cursor for Claude-style interactive sessions on mount and reset', async () => {
    const initialContent = '\u001b[?1049hClaude Code\nbypass permissions on';
    const nextContent = `${initialContent}\nnext`;
    const { rerender } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(DECTCEM_HIDE, expect.any(Function));
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextContent, { resetToken: 2 })}
        content={nextContent}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(DECTCEM_HIDE, expect.any(Function));
      expect(term.write).toHaveBeenCalledWith(nextContent, expect.any(Function));
    });
  });

  it('keeps the cursor visible by default for shell-style sessions', async () => {
    const content = 'plain shell prompt';
    render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    const hideCalls = term.write.mock.calls.filter(([chunk]) => chunk === DECTCEM_HIDE);
    expect(hideCalls).toHaveLength(0);
  });

  it('restores the cursor when cursorVisible toggles back on', async () => {
    const content = 'plain shell prompt';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    term.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(DECTCEM_SHOW, expect.any(Function));
    });
  });

  it('updates xterm scrollback when scrollbackLines changes on a mounted live terminal', async () => {
    const content = 'plain shell prompt';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        scrollbackLines={12000}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    expect(term.options.scrollback).toBe(12000);

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        scrollbackLines={24000}
      />
    );

    await waitFor(() => {
      expect(term.options.scrollback).toBe(24000);
    });
  });

  it('resets to the new snapshot when the live session id changes', async () => {
    const firstText = 'session a';
    const secondText = 'session b';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(firstText, { sessionId: 'session-1', resetToken: 1 })}
        content={firstText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(firstText, expect.any(Function));
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-2"
        streamState={buildStreamState(secondText, { sessionId: 'session-2', resetToken: 1 })}
        content={secondText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    const latestTerm = mocks.terminals[mocks.terminals.length - 1];
    await waitFor(() => {
      if (latestTerm === term) {
        expect(term.reset).toHaveBeenCalled();
      }
      expect(latestTerm.write).toHaveBeenCalledWith(secondText, expect.any(Function));
    });
  });

  it('keeps the live terminal mounted through a session-handoff mismatch until the stream catches up', async () => {
    const firstText = 'session one';
    const secondText = 'session two';
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(firstText, { sessionId: 'session-1', resetToken: 1 })}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(firstText, expect.any(Function));
    });

    rerender(
      <TerminalPanel
        sessionId="session-2"
        streamState={buildStreamState(firstText, { sessionId: 'session-1', resetToken: 1 })}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    expect(container.querySelector('.xterm-viewport')).not.toBeNull();
    expect(mocks.terminals).toHaveLength(1);

    rerender(
      <TerminalPanel
        sessionId="session-2"
        streamState={buildStreamState(secondText, { sessionId: 'session-2', resetToken: 2 })}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals[mocks.terminals.length - 1]?.write).toHaveBeenCalledWith(secondText, expect.any(Function));
    });
  });

  it('keeps the live xterm buffer when the host resizes during fullscreen rendering', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const onResize = vi.fn();
    const { container } = renderLivePanel(initialContent, {
      props: { onResize }
    });

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const host = container.querySelector('.terminal-host');
    expect(host).not.toBeNull();

    term.reset.mockClear();
    term.write.mockClear();

    await act(async () => {
      resizeObserverCallback?.(
        [
          {
            target: host as Element,
            contentRect: {
              width: 760,
              height: 520,
              top: 0,
              left: 0,
              bottom: 520,
              right: 760,
              x: 0,
              y: 0,
              toJSON: () => ''
            }
          } as ResizeObserverEntry
        ],
        {} as ResizeObserver
      );
    });

    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalledWith(initialContent, expect.any(Function));
    expect(onResize).toHaveBeenCalledWith(80, 24);
  });

  it('defers local fullscreen reflow until authoritative redraw arrives when live redraw is requested', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const onResize = vi.fn();
    const { container, rerender } = renderLivePanel(initialContent, {
      props: {
        onResize,
        preferLiveRedrawOnMount: true
      }
    });

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const host = container.querySelector('.terminal-host');
    expect(host).not.toBeNull();

    term.resize.mockClear();
    onResize.mockClear();
    mocks.proposedDimensions.cols = 100;
    mocks.proposedDimensions.rows = 30;

    await act(async () => {
      resizeObserverCallback?.(
        [
          {
            target: host as Element,
            contentRect: {
              width: 960,
              height: 640,
              top: 0,
              left: 0,
              bottom: 640,
              right: 960,
              x: 0,
              y: 0,
              toJSON: () => ''
            }
          } as ResizeObserverEntry
        ],
        {} as ResizeObserver
      );
    });

    expect(onResize).toHaveBeenCalledWith(100, 30);
    expect(term.resize).not.toHaveBeenCalledWith(100, 30);

    const nextContent = `${initialContent}\nnext frame`;
    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextContent, { resetToken: 2 })}
        content={nextContent}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        preferLiveRedrawOnMount
        onResize={onResize}
      />
    );

    await waitFor(() => {
      expect(term.resize).toHaveBeenCalledWith(100, 30);
      expect(term.write).toHaveBeenCalledWith(nextContent, expect.any(Function));
    });
  });

  it('does not surface Jump to latest from a programmatic resize scroll', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const { container, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const host = container.querySelector('.terminal-host');
    expect(host).not.toBeNull();

    await act(async () => {
      resizeObserverCallback?.(
        [
          {
            target: host as Element,
            contentRect: {
              width: 760,
              height: 520,
              top: 0,
              left: 0,
              bottom: 520,
              right: 760,
              x: 0,
              y: 0,
              toJSON: () => ''
            }
          } as ResizeObserverEntry
        ],
        {} as ResizeObserver
      );
    });

    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('shows Jump to latest after explicit user scroll and resumes on click', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Jump to latest' }));
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('establishes paused follow when wheel targets the visible terminal surface', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    expect(screen).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    await act(async () => {
      fireEvent.wheel(screen as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });
  });

  it('keeps follow paused after a slight wheel-up near the bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 980
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });
  });

  it('does not auto-resume when the viewport is only near the bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 996
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    expect(queryByRole('button', { name: 'Jump to latest' })).not.toBeNull();

    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 1000
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    });
  });

  it('does not yank the viewport back to bottom when output lands immediately after a user scroll-up gesture', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, rerender } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      rerender(
        <TerminalPanel
          sessionId="session-1"
          streamState={buildStreamState(`${initialContent}\nnew output`, {
            endPosition: initialContent.length + '\nnew output'.length,
            rawEndPosition: initialContent.length + '\nnew output'.length,
            chunks: [
              {
                rawStartPosition: initialContent.length,
                rawEndPosition: initialContent.length + '\nnew output'.length,
                startPosition: initialContent.length,
                endPosition: initialContent.length + '\nnew output'.length,
                data: '\nnew output'
              }
            ]
          })}
          content={`${initialContent}\nnew output`}
          readOnly={false}
          inputEnabled
          cursorVisible={false}
        />
      );
      await Promise.resolve();
    });

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });
  });

  it('continues appending live output while follow is paused without snapping to latest', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnew output`;
    const { container, getByRole, queryByRole, rerender } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.reset.mockClear();
    term.write.mockClear();
    term.scrollToBottom.mockClear();
    const pausedBaseY = term.buffer.active.baseY;
    const pausedViewportY = term.buffer.active.viewportY;

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextContent, {
          endPosition: nextContent.length,
          rawEndPosition: nextContent.length,
          chunks: [
            {
              rawStartPosition: initialContent.length,
              rawEndPosition: nextContent.length,
              startPosition: initialContent.length,
              endPosition: nextContent.length,
              data: '\nnew output'
            }
          ]
        })}
        content={nextContent}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(term.reset).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnew output', expect.any(Function));
    });
    expect(term.write).not.toHaveBeenCalledWith(nextContent, expect.any(Function));
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(term.buffer.active.baseY).toBeGreaterThan(pausedBaseY);
    expect(term.buffer.active.viewportY).toBe(pausedViewportY);
    expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Jump to latest' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.scrollToBottom).toHaveBeenCalled();
    });
    expect(term.reset).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('freezes paused stateful live output until follow resumes', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 48 }, (_, index) => `Claude line ${index + 1}`).join('\n')}`;
    const nextContent = `${initialContent}\nnext state`;
    const { container, getByRole, queryByRole, rerender } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.reset.mockClear();
    term.write.mockClear();
    term.scrollToBottom.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextContent, {
          endPosition: nextContent.length,
          rawEndPosition: nextContent.length,
          chunks: [
            {
              rawStartPosition: initialContent.length,
              rawEndPosition: nextContent.length,
              startPosition: initialContent.length,
              endPosition: nextContent.length,
              data: '\nnext state'
            }
          ]
        })}
        content={nextContent}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalledWith('\nnext state', expect.any(Function));
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Jump to latest' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(nextContent, expect.any(Function));
    });
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('freezes a queued append that races with a scroll-up pause and catches up on resume', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnew output`;
    const { container, getByRole, queryByRole, rerender } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    term.reset.mockClear();
    term.write.mockClear();
    term.scrollToBottom.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          streamState={buildStreamState(nextContent, {
            endPosition: nextContent.length,
            rawEndPosition: nextContent.length,
            chunks: [
              {
                rawStartPosition: initialContent.length,
                rawEndPosition: nextContent.length,
                startPosition: initialContent.length,
                endPosition: nextContent.length,
                data: '\nnew output'
              }
            ]
          })}
          content={nextContent}
          readOnly={false}
          inputEnabled
          cursorVisible={false}
        />
      );
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnew output', expect.any(Function));
    });
    expect(term.write).not.toHaveBeenCalledWith(nextContent, expect.any(Function));
    expect(term.scrollToBottom).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Jump to latest' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.scrollToBottom).toHaveBeenCalled();
    });
    expect(term.reset).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('does not let a suppressed programmatic scroll event cancel a wheel-initiated pause', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const host = container.querySelector('.terminal-host');
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(host).not.toBeNull();
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    await act(async () => {
      resizeObserverCallback?.(
        [
          {
            target: host as Element,
            contentRect: {
              width: 760,
              height: 520,
              top: 0,
              left: 0,
              bottom: 520,
              right: 760,
              x: 0,
              y: 0,
              toJSON: () => ''
            }
          } as ResizeObserverEntry
        ],
        {} as ResizeObserver
      );
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      await Promise.resolve();
    });

    term.buffer.active.viewportY = term.buffer.active.baseY;
    term.isUserScrolling = false;

    await act(async () => {
      for (const listener of term.onScrollListeners) {
        listener(term.buffer.active.viewportY);
      }
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });
  });

  it('resumes follow when new terminal key input arrives while paused', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitKey(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('resumes follow when the live viewport drifts off bottom while still following', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitKey(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('skips live resume work when already following at the bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement, 1000);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitKey(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('does not resume follow when onData fires without a user-input event', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitData(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).not.toBeNull();
  });

  it('resumes follow when helper textarea dispatches input', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.input(textarea as HTMLTextAreaElement);
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('resumes follow when helper textarea dispatches compositionend', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.compositionEnd(textarea as HTMLTextAreaElement, { data: 'あ' });
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('resumes follow when helper textarea dispatches paste', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent(textarea as HTMLTextAreaElement, new Event('paste', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('resumes follow when text is dropped into the live terminal', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.drop(viewport as HTMLElement, {
        dataTransfer: { types: ['text/plain'] }
      });
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('does not resume follow for non-text drops in the live terminal', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.drop(viewport as HTMLElement, {
        dataTransfer: { types: ['Files'] }
      });
      await Promise.resolve();
    });

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).not.toBeNull();
  });

  it('resumes follow before sending Shift+Enter', async () => {
    const onData = vi.fn();
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLivePanel(initialContent, {
      props: { onData }
    });

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    const customKeyHandler = term.attachCustomKeyEventHandler.mock.calls[0]?.[0] as
      | ((event: KeyboardEvent) => boolean)
      | undefined;
    expect(customKeyHandler).toBeTypeOf('function');

    term.scrollToBottom.mockClear();
    const event = {
      type: 'keydown',
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as KeyboardEvent;

    await act(async () => {
      const result = customKeyHandler?.(event);
      expect(result).toBe(false);
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(onData).toHaveBeenCalledWith(MULTILINE_ENTER_SEQUENCE);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when new terminal key input arrives while paused', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitKey(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when helper textarea dispatches input', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.input(textarea as HTMLTextAreaElement);
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when helper textarea dispatches compositionend', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.compositionEnd(textarea as HTMLTextAreaElement, { data: 'あ' });
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when helper textarea dispatches paste', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent(textarea as HTMLTextAreaElement, new Event('paste', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when text is dropped into the terminal', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.drop(viewport as HTMLElement, {
        dataTransfer: { types: ['text/plain'] }
      });
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel does not resume follow for non-text drops', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.drop(viewport as HTMLElement, {
        dataTransfer: { types: ['Files'] }
      });
      await Promise.resolve();
    });

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).not.toBeNull();
  });

  it('legacy panel resumes follow before sending Shift+Enter', async () => {
    const onData = vi.fn();
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent, {
      props: { onData }
    });

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    const customKeyHandler = term.attachCustomKeyEventHandler.mock.calls[0]?.[0] as
      | ((event: KeyboardEvent) => boolean)
      | undefined;
    expect(customKeyHandler).toBeTypeOf('function');

    term.scrollToBottom.mockClear();
    const event = {
      type: 'keydown',
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as KeyboardEvent;

    await act(async () => {
      const result = customKeyHandler?.(event);
      expect(result).toBe(false);
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    await waitFor(() => {
      expect(onData).toHaveBeenCalledWith(MULTILINE_ENTER_SEQUENCE);
    });
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel does not resume follow when onData fires without a user-input event', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);

    await pauseFollowByWheelScroll(viewport as HTMLElement);

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitData(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).not.toBeNull();
  });

  it('legacy panel skips resume work when already following at the bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement, 1000);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitKey(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when the viewport drifts off bottom while still following', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    term.scrollToBottom.mockClear();
    await act(async () => {
      mocks.emitKey(term, 'x');
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when helper textarea input arrives while drifted off bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.input(textarea as HTMLTextAreaElement);
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('legacy panel resumes follow when helper textarea paste arrives while drifted off bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, queryByRole } = renderLegacyPanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    expect(viewport).not.toBeNull();
    expect(textarea).not.toBeNull();
    setDefaultScrollbackViewport(viewport as HTMLElement);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent(textarea as HTMLTextAreaElement, new Event('paste', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('reports follow pause changes when the user scrolls away from the bottom', async () => {
    const pauseChanges: boolean[] = [];
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container } = renderLivePanel(initialContent, {
      props: {
        onFollowOutputPausedChange: (paused: boolean) => {
          pauseChanges.push(paused);
        }
      }
    });

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    expect(pauseChanges).toContain(false);
    expect(pauseChanges).toContain(true);
  });

  it('keeps a paused stateful screen frozen until follow resumes', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 48 }, (_, index) => `Claude line ${index + 1}`).join('\n')}`;
    const nextContent = `${initialContent}\nnext state`;
    const { container, getByRole, rerender } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.reset.mockClear();
    term.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextContent, { resetToken: 2 })}
        content={nextContent}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalledWith(nextContent, expect.any(Function));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Jump to latest' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(nextContent, expect.any(Function));
    });
  });

  it('does not reopen search on remount for an already-handled toggle request id', async () => {
    const content = 'search target';
    const { queryByTestId, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        searchToggleRequestId={1}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    expect(queryByTestId('terminal-search')).toBeNull();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        searchToggleRequestId={1}
      />
    );

    expect(queryByTestId('terminal-search')).toBeNull();
  });

  it('falls back to undecorated live search when the addon rejects decorations', async () => {
    const content = 'search target';
    const { getByTestId, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        searchToggleRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const searchAddon = term.loadAddon.mock.calls[1]?.[0];
    expect(searchAddon).toBeDefined();
    searchAddon.findNext
      .mockImplementationOnce(() => {
        throw new Error('decorations fail');
      })
      .mockImplementation(() => true);

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(content)}
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        searchToggleRequestId={1}
      />
    );

    const input = await waitFor(() => getByTestId('terminal-search-input'));
    await act(async () => {
      fireEvent.change(input, { target: { value: 'search' } });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(searchAddon.findNext).toHaveBeenCalledTimes(2);
    });
    expect(searchAddon.findNext).toHaveBeenNthCalledWith(
      1,
      'search',
      expect.objectContaining({
        incremental: true,
        decorations: expect.any(Object)
      })
    );
    expect(searchAddon.findNext).toHaveBeenNthCalledWith(
      2,
      'search',
      expect.objectContaining({
        incremental: true
      })
    );
  });

  it('preserves the paused scrollback offset through host resize', async () => {
    const initialContent = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container } = renderLivePanel(initialContent);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const host = container.querySelector('.terminal-host');
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(host).not.toBeNull();
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    term.reset.mockClear();
    term.scrollToLine.mockClear();
    await act(async () => {
      resizeObserverCallback?.(
        [
          {
            target: host as Element,
            contentRect: {
              width: 760,
              height: 520,
              top: 0,
              left: 0,
              bottom: 520,
              right: 760,
              x: 0,
              y: 0,
              toJSON: () => ''
            }
          } as ResizeObserverEntry
        ],
        {} as ResizeObserver
      );
      await Promise.resolve();
    });

    expect(term.reset).not.toHaveBeenCalled();
    expect(term.scrollToLine).toHaveBeenCalled();
  });

  it('rebuilds the live terminal from the latest snapshot when a repair is requested', async () => {
    const initialText = 'one\ntwo';
    const nextText = 'three\nfour';
    const { rerender } = renderLivePanel(initialText);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialText, expect.any(Function));
    });

    term.reset.mockClear();
    term.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextText, { resetToken: 2 })}
        content={nextText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(nextText, expect.any(Function));
    });
  });

  it('defers repair-triggered snapshot replay while follow is paused until resume', async () => {
    const initialText = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextText = Array.from({ length: 48 }, (_, index) => `next ${index + 1}`).join('\n');
    const { container, getByRole, queryByRole, rerender } = renderLivePanel(initialText);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 900
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.reset.mockClear();
    term.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextText, { resetToken: 2 })}
        content={nextText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        repairRequestId={1}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalledWith(nextText, expect.any(Function));

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Jump to latest' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(nextText, expect.any(Function));
    });
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('waits for async snapshot replay before scrolling to latest', async () => {
    const initialText = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextText = Array.from({ length: 48 }, (_, index) => `next ${index + 1}`).join('\n');
    const { rerender } = renderLivePanel(initialText);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialText, expect.any(Function));
    });

    const originalWrite = term.write.getMockImplementation();
    let releaseSnapshotWrite: (() => void) | null = null;
    term.write.mockImplementation((chunk: string, callback?: () => void) => {
      if (chunk === nextText) {
        originalWrite?.(chunk, () => {
          releaseSnapshotWrite = callback ?? null;
        });
        return;
      }
      originalWrite?.(chunk, callback);
    });

    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    term.reset.mockClear();
    term.write.mockClear();
    term.scrollToLine.mockClear();
    term.scrollToBottom.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(nextText, { resetToken: 2 })}
        content={nextText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(nextText, expect.any(Function));
      expect(releaseSnapshotWrite).toBeTypeOf('function');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(term.scrollToLine).not.toHaveBeenCalled();
    expect(term.scrollToBottom).not.toHaveBeenCalled();

    await act(async () => {
      releaseSnapshotWrite?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.scrollToBottom).toHaveBeenCalled();
    });
  });

  it('serializes reset-token replays so a newer snapshot does not start before an older async write settles', async () => {
    const initialText = 'initial snapshot';
    const olderText = 'older snapshot';
    const newerText = 'newer snapshot';
    const { rerender } = renderLivePanel(initialText);

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const originalWrite = term.write.getMockImplementation();
    let releaseOlderSnapshot: (() => void) | null = null;
    term.write.mockImplementation((chunk: string, callback?: () => void) => {
      if (chunk === olderText) {
        releaseOlderSnapshot = () => {
          originalWrite?.(chunk, callback);
        };
        return;
      }
      originalWrite?.(chunk, callback);
    });

    term.reset.mockClear();
    term.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(olderText, { resetToken: 2 })}
        content={olderText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );
    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(newerText, { resetToken: 3 })}
        content={newerText}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    expect(term.write).not.toHaveBeenCalledWith(newerText, expect.any(Function));

    await act(async () => {
      releaseOlderSnapshot?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(newerText, expect.any(Function));
    });
  });

  it('queues incremental deltas behind an in-flight snapshot replay', async () => {
    const initialText = 'initial snapshot';
    const snapshotText = 'replacement snapshot';
    const appendedChunk = ' + delta';
    const appendedText = `${snapshotText}${appendedChunk}`;
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(initialText, { resetToken: 1 })}
        content={initialText}
        readOnly={false}
        inputEnabled
        cursorVisible
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    const originalWrite = term.write.getMockImplementation();
    let releaseSnapshotWrite: (() => void) | null = null;
    term.write.mockImplementation((chunk: string, callback?: () => void) => {
      if (chunk === snapshotText) {
        releaseSnapshotWrite = () => {
          originalWrite?.(chunk, callback);
        };
        return;
      }
      originalWrite?.(chunk, callback);
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(snapshotText, {
          resetToken: 2,
          endPosition: snapshotText.length,
          rawEndPosition: snapshotText.length,
          chunks: []
        })}
        content={snapshotText}
        readOnly={false}
        inputEnabled
        cursorVisible
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={buildStreamState(appendedText, {
          resetToken: 2,
          endPosition: appendedText.length,
          rawEndPosition: appendedText.length,
          chunks: [
            {
              rawStartPosition: snapshotText.length,
              rawEndPosition: appendedText.length,
              startPosition: snapshotText.length,
              endPosition: appendedText.length,
              data: appendedChunk
            }
          ]
        })}
        content={appendedText}
        readOnly={false}
        inputEnabled
        cursorVisible
      />
    );

    expect(term.write).not.toHaveBeenCalledWith(appendedChunk, expect.any(Function));

    await act(async () => {
      releaseSnapshotWrite?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      const writtenChunks = term.write.mock.calls.map(([chunk]) => chunk);
      expect(writtenChunks).toContain(snapshotText);
      expect(writtenChunks).toContain(appendedChunk);
      expect(writtenChunks.indexOf(snapshotText)).toBeLessThan(writtenChunks.indexOf(appendedChunk));
    });
  });
});
