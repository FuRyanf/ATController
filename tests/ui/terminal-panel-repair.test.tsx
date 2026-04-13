import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DECTCEM_HIDE = '\u001b[?25l';
const DECTCEM_SHOW = '\u001b[?25h';

let resizeObserverCallback: ResizeObserverCallback | null = null;

const mocks = vi.hoisted(() => {
  const fit = vi.fn();
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
        const viewport = document.createElement('div');
        viewport.className = 'xterm-viewport';
        viewport.addEventListener('wheel', (event) => {
          if (viewport.dataset.skipXtermWheel === 'true') {
            return;
          }
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
        host.appendChild(viewport);
      }),
      loadAddon: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
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
    fit,
    terminals
  };
});

vi.mock('../../src/lib/api', () => ({
  api: {
    openExternalUrl: vi.fn(async () => undefined)
  }
}));

vi.mock('xterm', () => ({
  Terminal: vi.fn(() => mocks.createTerminal())
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: mocks.fit,
    proposeDimensions: () => {
      mocks.fit();
      return { cols: 80, rows: 24 };
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

function renderClaudePanel(props: Record<string, unknown> = {}) {
  return render(
    <TerminalPanel
      sessionId="session-1"
      streamState={{
        sessionId: 'session-1',
        text: '',
        startPosition: 0,
        endPosition: 0,
        truncated: false,
        phase: 'live',
        resetToken: 0
      }}
      readOnly={false}
      inputEnabled
      cursorVisible={false}
      focusRequestId={0}
      repairRequestId={0}
      searchToggleRequestId={0}
      onData={() => undefined}
      onResize={() => undefined}
      onFocusChange={() => undefined}
      {...props}
    />
  );
}

function setViewportMetrics(
  viewport: HTMLElement,
  {
    clientHeight,
    scrollHeight,
    scrollTop,
    clientWidth,
    offsetWidth
  }: {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
    clientWidth?: number;
    offsetWidth?: number;
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
  if (typeof clientWidth === 'number') {
    Object.defineProperty(viewport, 'clientWidth', {
      configurable: true,
      value: clientWidth
    });
  }
  if (typeof offsetWidth === 'number') {
    Object.defineProperty(viewport, 'offsetWidth', {
      configurable: true,
      value: offsetWidth
    });
  }
}

function installQueuedRaf() {
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;
  let nextRafId = 1;
  const queuedRafs = new Map<number, FrameRequestCallback>();

  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextRafId++;
    queuedRafs.set(id, callback);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    queuedRafs.delete(id);
  }) as typeof window.cancelAnimationFrame;

  return {
    flush() {
      while (queuedRafs.size > 0) {
        const callbacks = Array.from(queuedRafs.entries());
        queuedRafs.clear();
        for (const [, callback] of callbacks) {
          callback(0);
        }
      }
    },
    restore() {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    }
  };
}

describe('TerminalPanel manual repair', () => {
  beforeEach(() => {
    (globalThis as { __ATCONTROLLER_ENABLE_XTERM_TESTS__?: boolean }).__ATCONTROLLER_ENABLE_XTERM_TESTS__ = true;
    mocks.fit.mockClear();
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

  it('rebuilds the xterm buffer from the latest content when a repair is requested', async () => {
    const content = 'line 1\nline 2\nline 3';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(firstTerm.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.terminals).toHaveLength(2);
    });

    const repairedTerm = mocks.terminals[1];
    await waitFor(() => {
      expect(repairedTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });
  });

  it('replays the raw terminal log on manual repair without injecting extra cursor movement', async () => {
    const rawContent = '> Try again';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={rawContent}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    firstTerm.screenLines = ['> Try again'];
    firstTerm.wrappedRows.clear();
    firstTerm.buffer.active.cursorX = 5;

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={rawContent}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(2);
    });

    const repairedTerm = mocks.terminals[1];
    await waitFor(() => {
      expect(repairedTerm.write).toHaveBeenCalledWith(rawContent, expect.any(Function));
    });
    expect(
      repairedTerm.write.mock.calls.some(
        ([chunk]) => typeof chunk === 'string' && /^\u001b\[\d+;\d+H$/u.test(chunk)
      )
    ).toBe(false);

    repairedTerm.write.mockClear();
    repairedTerm.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={`${rawContent}!`}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(repairedTerm.write).toHaveBeenCalledWith('!', expect.any(Function));
      expect(repairedTerm.reset).not.toHaveBeenCalled();
    });
  });

  it('hides the xterm cursor for Claude-style interactive sessions on mount and reset', async () => {
    const content = '> prompt';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(DECTCEM_HIDE);
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    firstTerm.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-2"
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      const latestTerm = mocks.terminals[mocks.terminals.length - 1];
      if (latestTerm === firstTerm) {
        expect(firstTerm.reset).toHaveBeenCalled();
        return;
      }
      expect(latestTerm).not.toBe(firstTerm);
      expect(latestTerm.write).toHaveBeenCalledWith(DECTCEM_HIDE);
    });
  });

  it('keeps the xterm cursor visible by default for shell-style sessions', async () => {
    render(
      <TerminalPanel
        sessionId="session-1"
        content="shell prompt"
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(DECTCEM_SHOW);
    });
    expect(firstTerm.write).not.toHaveBeenCalledWith(DECTCEM_HIDE);
  });

  it('restores the viewport when the user was scrolled up during repair', async () => {
    const content = Array.from({ length: 32 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    firstTerm.buffer.active.viewportY = 4;

    const host = container.querySelector('.terminal-host');
    expect(host).not.toBeNull();
    fireEvent.wheel(host as HTMLElement, { deltaY: -32 });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(2);
    });

    const repairedTerm = mocks.terminals[1];
    await waitFor(() => {
      expect(repairedTerm.scrollToLine).toHaveBeenCalledWith(4);
    });
  });

  it('preserves relative scroll position through host resize while paused', async () => {
    const originalRaf = window.requestAnimationFrame;
    const originalCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;

    try {
      const content = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
      const { container } = render(
        <TerminalPanel
          sessionId="session-1"
          content={content}
          readOnly={false}
          inputEnabled
          repairRequestId={0}
        />
      );

      await waitFor(() => {
        expect(mocks.terminals).toHaveLength(1);
      });

      const firstTerm = mocks.terminals[0];
      await waitFor(() => {
        expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
      });

      firstTerm.buffer.active.baseY = 20;
      firstTerm.buffer.active.viewportY = 12;

      const host = container.querySelector('.terminal-host');
      expect(host).not.toBeNull();
      fireEvent.wheel(host as HTMLElement, { deltaY: -32 });
      firstTerm.buffer.active.baseY = 20;
      firstTerm.buffer.active.viewportY = 12;
      firstTerm.scrollToBottom.mockClear();

      mocks.fit.mockImplementationOnce(() => {
        firstTerm.buffer.active.baseY = 28;
      });

      expect(resizeObserverCallback).not.toBeNull();

      await act(async () => {
        resizeObserverCallback?.([], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(firstTerm.scrollToLine).toHaveBeenCalledWith(20);
      });
      expect(firstTerm.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    }
  });

  it('preserves a paused viewport when a deferred mount reflow fires after the user scrolls up', async () => {
    const queuedRaf = installQueuedRaf();
    try {
      const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
      const nextContent = `${initialContent}\nnext streamed line`;
      const { container, rerender } = render(
        <TerminalPanel
          sessionId="session-1"
          content={initialContent}
          contentByteCount={initialContent.length}
          contentGeneration={0}
          readOnly={false}
          inputEnabled
        />
      );

      await waitFor(() => {
        expect(mocks.terminals).toHaveLength(1);
      });

      const term = mocks.terminals[0];
      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
      });

      const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
      expect(viewport).not.toBeNull();

      term.buffer.active.baseY = 20;
      term.buffer.active.viewportY = 12;
      term.isUserScrolling = true;
      setViewportMetrics(viewport as HTMLElement, {
        clientHeight: 200,
        scrollHeight: 1200,
        scrollTop: 600
      });

      term.scrollToLine.mockClear();
      term.scrollToBottom.mockClear();
      mocks.fit.mockClear();

      await act(async () => {
        fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      });

      term.buffer.active.baseY = 20;
      term.buffer.active.viewportY = 12;
      term.isUserScrolling = true;

      mocks.fit.mockImplementationOnce(() => {
        term.buffer.active.baseY = 24;
        term.buffer.active.viewportY = 24;
      });

      await act(async () => {
        queuedRaf.flush();
      });

      await waitFor(() => {
        expect(term.scrollToLine).toHaveBeenCalledWith(16);
      });
      expect(term.scrollToBottom).not.toHaveBeenCalled();
      expect(term.buffer.active.viewportY).toBeLessThan(term.buffer.active.baseY);

      term.write.mockClear();
      term.scrollToBottom.mockClear();

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={nextContent}
            contentByteCount={nextContent.length}
            contentGeneration={0}
            readOnly={false}
            inputEnabled
          />
        );
      });

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      });
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });

  it('skips synthetic local reflow nudges after a live session has already rendered content', async () => {
    const queuedRaf = installQueuedRaf();
    try {
      const initialContent = [
        '\u001b[?1049h',
        'Claude Code v2.1.101',
        '\n',
        'Whirlpooling...'
      ].join('');

      render(
        <TerminalPanel
          sessionId="session-1"
          streamState={{
            sessionId: 'session-1',
            phase: 'ready',
            text: initialContent,
            rawEndPosition: initialContent.length,
            startPosition: 0,
            endPosition: initialContent.length,
            chunks: [
              {
                rawStartPosition: 0,
                rawEndPosition: initialContent.length,
                startPosition: 0,
                endPosition: initialContent.length,
                data: initialContent
              }
            ],
            resetToken: 1
          }}
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
        expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
      });

      term.resize.mockClear();

      await act(async () => {
        queuedRaf.flush();
        await Promise.resolve();
      });

      expect(term.resize).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });

  it('defers initial replay for stateful live sessions and falls back if no redraw arrives', async () => {
    const initialContent = [
      '\u001b[?1049h',
      'Claude Code v2.1.101',
      '\n',
      'Message from LinkedIn Claude:'
    ].join('');

    render(
      <TerminalPanel
        sessionId="session-1"
        preferLiveRedrawOnMount
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: initialContent,
          rawEndPosition: initialContent.length,
          startPosition: 0,
          endPosition: initialContent.length,
          chunks: [
            {
              rawStartPosition: 0,
              rawEndPosition: initialContent.length,
              startPosition: 0,
              endPosition: initialContent.length,
              data: initialContent
            }
          ],
          resetToken: 1
        }}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    expect(
      term.write.mock.calls.some(([chunk]) => chunk === initialContent)
    ).toBe(false);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_450));
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });
  });

  it('reports follow pause changes when the user scrolls away from the bottom', async () => {
    const onFollowOutputPausedChange = vi.fn();
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        readOnly={false}
        inputEnabled
        onFollowOutputPausedChange={onFollowOutputPausedChange}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 700
    });

    onFollowOutputPausedChange.mockClear();

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
      fireEvent.scroll(viewport as HTMLElement);
    });

    await waitFor(() => {
      expect(onFollowOutputPausedChange).toHaveBeenCalledWith(true);
    });
  });

  it('does not pause follow from viewport movement without explicit user scroll intent', async () => {
    const onFollowOutputPausedChange = vi.fn();
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, queryByRole } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        readOnly={false}
        inputEnabled
        onFollowOutputPausedChange={onFollowOutputPausedChange}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 700
    });

    onFollowOutputPausedChange.mockClear();

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    expect(onFollowOutputPausedChange).not.toHaveBeenCalledWith(true);
    expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('freezes stateful screen updates while paused and resyncs to latest on jump', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const nextContent = `${initialContent}\nrepainted latest line`;
    const { container, rerender, getByRole } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: initialContent,
          rawEndPosition: initialContent.length,
          startPosition: 0,
          endPosition: initialContent.length,
          chunks: [
            {
              rawStartPosition: 0,
              rawEndPosition: initialContent.length,
              startPosition: 0,
              endPosition: initialContent.length,
              data: initialContent
            }
          ],
          resetToken: 1
        }}
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
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 700
    });

    await act(async () => {
      const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0]?.[0] as
        | ((event: { type: string; key: string }) => boolean)
        | undefined;
      keyHandler?.({ type: 'keydown', key: 'PageUp' });
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: nextContent,
          rawEndPosition: nextContent.length,
          startPosition: 0,
          endPosition: nextContent.length,
          chunks: [
            {
              rawStartPosition: initialContent.length,
              rawEndPosition: nextContent.length,
              startPosition: initialContent.length,
              endPosition: nextContent.length,
              data: '\nrepainted latest line'
            }
          ],
          resetToken: 1
        }}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(term.write).not.toHaveBeenCalledWith('\nrepainted latest line', expect.any(Function));
    expect(term.reset).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Jump to latest' }));
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(nextContent, expect.any(Function));
    });
  });

  it('resumes a frozen stateful screen when viewport scroll returns near bottom without Jump to latest', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const nextContent = `${initialContent}\nrepainted latest line`;
    const { container, rerender, getByRole, queryByRole } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: initialContent,
          rawEndPosition: initialContent.length,
          startPosition: 0,
          endPosition: initialContent.length,
          chunks: [
            {
              rawStartPosition: 0,
              rawEndPosition: initialContent.length,
              startPosition: 0,
              endPosition: initialContent.length,
              data: initialContent
            }
          ],
          resetToken: 1
        }}
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
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 700
    });

    await act(async () => {
      const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0]?.[0] as
        | ((event: { type: string; key: string }) => boolean)
        | undefined;
      keyHandler?.({ type: 'keydown', key: 'PageUp' });
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: nextContent,
          rawEndPosition: nextContent.length,
          startPosition: 0,
          endPosition: nextContent.length,
          chunks: [
            {
              rawStartPosition: initialContent.length,
              rawEndPosition: nextContent.length,
              startPosition: initialContent.length,
              endPosition: nextContent.length,
              data: '\nrepainted latest line'
            }
          ],
          resetToken: 1
        }}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(term.write).not.toHaveBeenCalledWith('\nrepainted latest line', expect.any(Function));
    expect(term.reset).not.toHaveBeenCalled();

    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 980
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(nextContent, expect.any(Function));
      expect(queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    });
  });

  it('does not auto-resume a frozen stateful screen from a small upward wheel move near bottom', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const { container, getByRole } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: initialContent,
          rawEndPosition: initialContent.length,
          startPosition: 0,
          endPosition: initialContent.length,
          chunks: [
            {
              rawStartPosition: 0,
              rawEndPosition: initialContent.length,
              startPosition: 0,
              endPosition: initialContent.length,
              data: initialContent
            }
          ],
          resetToken: 1
        }}
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
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 1000
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 980
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('freezes stateful screen updates while detached and resumes near bottom without requiring an exact jump', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const nextContent = `${initialContent}\nrepainted latest line`;
    const { container, rerender, getByRole } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: initialContent,
          rawEndPosition: initialContent.length,
          startPosition: 0,
          endPosition: initialContent.length,
          chunks: [
            {
              rawStartPosition: 0,
              rawEndPosition: initialContent.length,
              startPosition: 0,
              endPosition: initialContent.length,
              data: initialContent
            }
          ],
          resetToken: 1
        }}
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
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 700
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Jump to latest' })).toBeDefined();
    });

    term.write.mockClear();
    term.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: nextContent,
          rawEndPosition: nextContent.length,
          startPosition: 0,
          endPosition: nextContent.length,
          chunks: [
            {
              rawStartPosition: initialContent.length,
              rawEndPosition: nextContent.length,
              startPosition: initialContent.length,
              endPosition: nextContent.length,
              data: '\nrepainted latest line'
            }
          ],
          resetToken: 1
        }}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(term.write).not.toHaveBeenCalledWith('\nrepainted latest line', expect.any(Function));
    expect(term.reset).not.toHaveBeenCalled();

    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 980
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalled();
      expect(term.write).toHaveBeenCalledWith(nextContent, expect.any(Function));
    });
  });

  it('requests a stateful resync when the host resizes during live fullscreen rendering', async () => {
    const initialContent = `\u001b[?1049h${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}`;
    const onStatefulRedrawRequest = vi.fn();
    render(
      <TerminalPanel
        sessionId="session-1"
        streamState={{
          sessionId: 'session-1',
          phase: 'ready',
          text: initialContent,
          rawEndPosition: initialContent.length,
          startPosition: 0,
          endPosition: initialContent.length,
          chunks: [
            {
              rawStartPosition: 0,
              rawEndPosition: initialContent.length,
              startPosition: 0,
              endPosition: initialContent.length,
              data: initialContent
            }
          ],
          resetToken: 1
        }}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        onStatefulRedrawRequest={onStatefulRedrawRequest}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    expect(resizeObserverCallback).not.toBeNull();
    term.scrollToLine.mockClear();
    term.resize.mockClear();
    term.cols = 64;
    term.rows = 20;

    await act(async () => {
      resizeObserverCallback?.([], {} as ResizeObserver);
      await Promise.resolve();
    });

    expect(onStatefulRedrawRequest).toHaveBeenCalledTimes(1);
    expect(term.scrollToLine).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();
  });

  it('restores the latest paused viewport when streamed output lands before fit-preserve capture runs', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const queuedRaf = installQueuedRaf();
    try {
      mocks.fit.mockImplementationOnce(() => {
        term.buffer.active.baseY = 24;
      });

      expect(resizeObserverCallback).not.toBeNull();

      await act(async () => {
        resizeObserverCallback?.([], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(term.scrollToLine).toHaveBeenCalledWith(16);
      });

      setViewportMetrics(viewport as HTMLElement, {
        clientHeight: 200,
        scrollHeight: 1240,
        scrollTop: 640
      });
      term.buffer.active.baseY = 24;
      term.buffer.active.viewportY = 16;

      const originalWrite = term.write.getMockImplementation();
      term.write.mockImplementation((chunk: string, callback?: () => void) => {
        originalWrite?.(chunk, () => {
          if (chunk === '\nnext streamed line') {
            term.buffer.active.baseY = 24;
            term.buffer.active.viewportY = 18;
            setViewportMetrics(viewport as HTMLElement, {
              clientHeight: 200,
              scrollHeight: 1280,
              scrollTop: 680
            });
            fireEvent.scroll(viewport as HTMLElement);
          }
          callback?.();
        });
      });

      term.write.mockClear();
      term.scrollToBottom.mockClear();

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={nextContent}
            contentByteCount={nextContent.length}
            contentGeneration={0}
            readOnly={false}
            inputEnabled
          />
        );
      });

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      });
      expect((viewport as HTMLElement).scrollTop).toBe(680);

      await act(async () => {
        queuedRaf.flush();
      });

      expect((viewport as HTMLElement).scrollTop).toBe(640);
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });

  it('restores the latest paused viewport after a focus-request deferred resize fires while paused', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
        focusRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const queuedRaf = installQueuedRaf();
    try {
      term.cols = 79;
      term.resize.mockClear();
      term.scrollToBottom.mockClear();

      const originalResize = term.resize.getMockImplementation();
      term.resize.mockImplementation((cols: number, rows: number) => {
        originalResize?.(cols, rows);
        if (cols === 80 && rows === 24) {
          setViewportMetrics(viewport as HTMLElement, {
            clientHeight: 200,
            scrollHeight: 1240,
            scrollTop: 640
          });
          fireEvent.scroll(viewport as HTMLElement);
        }
      });

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={initialContent}
            contentByteCount={initialContent.length}
            contentGeneration={0}
            readOnly={false}
            inputEnabled
            focusRequestId={1}
          />
        );
      });

      expect(term.focus).toHaveBeenCalled();

      await act(async () => {
        queuedRaf.flush();
      });

      expect(term.resize).toHaveBeenCalledWith(80, 24);
      expect((viewport as HTMLElement).scrollTop).toBe(640);
      expect(term.scrollToBottom).not.toHaveBeenCalled();

      const originalWrite = term.write.getMockImplementation();
      term.write.mockImplementation((chunk: string, callback?: () => void) => {
        originalWrite?.(chunk, () => {
          if (chunk === '\nnext streamed line') {
            setViewportMetrics(viewport as HTMLElement, {
              clientHeight: 200,
              scrollHeight: 1280,
              scrollTop: 680
            });
            fireEvent.scroll(viewport as HTMLElement);
          }
          callback?.();
        });
      });

      term.write.mockClear();
      term.scrollToBottom.mockClear();

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={nextContent}
            contentByteCount={nextContent.length}
            contentGeneration={0}
            readOnly={false}
            inputEnabled
            focusRequestId={1}
          />
        );
      });

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      });
      expect((viewport as HTMLElement).scrollTop).toBe(680);

      await act(async () => {
        queuedRaf.flush();
      });

      expect((viewport as HTMLElement).scrollTop).toBe(640);
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });

  it('pauses follow from a wheel event before a streamed append lands', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    viewport!.dataset.skipXtermWheel = 'true';
    viewport!.addEventListener('wheel', (event) => {
      event.stopPropagation();
    });

    term.scrollToBottom.mockClear();
    fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });

    const nextContent = `${initialContent}\nnext streamed line`;
    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={nextContent}
        contentByteCount={nextContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('preserves an off-bottom viewport without surfacing paused follow UI', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      value: 200
    });
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 1200
    });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 700
    });

    term.scrollToBottom.mockClear();
    fireEvent.scroll(viewport as HTMLElement);

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('.terminal-follow-button')).toBeNull();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={nextContent}
        contentByteCount={nextContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('resumes follow and keeps the viewport at latest when the user types while detached', async () => {
    const onData = vi.fn();
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
        onData={onData}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('.terminal-follow-button')).toBeNull();

    // Model the live path where native viewport scrolling has moved the DOM off-bottom,
    // but xterm's internal viewportY has already drifted back to baseY.
    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();
    await act(async () => {
      mocks.emitData(term, 'x');
      mocks.emitData(term, '\r');
    });

    await waitFor(() => {
      expect(term.scrollToBottom).toHaveBeenCalled();
      expect(onData).toHaveBeenCalledWith('x\r');
      expect(container.querySelector('.terminal-follow-button')).toBeNull();
      expect((viewport as HTMLElement).scrollTop).toBe(1000);
    });

    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();
    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={0}
          readOnly={false}
          inputEnabled
          onData={onData}
        />
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });

  it('hides the cursor immediately after submitting input on a stateful Claude screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onData = vi.fn();
      const content = [
        '\u001b[2J\u001b[HClaude Code v2.1.101',
        'bypass permissions on',
        '> prompt'
      ].join('\n');
      render(
        <TerminalPanel
          sessionId="session-1"
          content={content}
          contentByteCount={content.length}
          contentGeneration={0}
          readOnly={false}
          inputEnabled
          onData={onData}
        />
      );

      await waitFor(() => {
        expect(mocks.terminals).toHaveLength(1);
      });

      const term = mocks.terminals[0];
      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith(content, expect.any(Function));
      });

      term.write.mockClear();

      await act(async () => {
        mocks.emitData(term, 'x');
        mocks.emitData(term, '\r');
      });

      await waitFor(() => {
        expect(onData).toHaveBeenCalledWith('x\r');
        expect(term.write).toHaveBeenCalledWith(DECTCEM_HIDE);
      });

      await act(async () => {
        vi.advanceTimersByTime(1_200);
      });

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith(DECTCEM_SHOW);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hide the cursor after submit on a plain shell screen', async () => {
    const onData = vi.fn();
    const content = 'shell prompt';
    render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        contentByteCount={content.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
        onData={onData}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    term.write.mockClear();

    await act(async () => {
      mocks.emitData(term, 'x');
      mocks.emitData(term, '\r');
    });

    await waitFor(() => {
      expect(onData).toHaveBeenCalledWith('x\r');
    });

    expect(term.write).not.toHaveBeenCalledWith(DECTCEM_HIDE);
  });

  it('does not pause follow for a viewport scroll event that remains at bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      value: 200
    });
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 1200
    });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 1000
    });

    term.scrollToBottom.mockClear();
    fireEvent.scroll(viewport as HTMLElement);

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={nextContent}
        contentByteCount={nextContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).toHaveBeenCalled();
  });

  it('does not pause follow for a transient off-bottom xterm callback while the user is still at bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    for (const listener of term.onScrollListeners) {
      term.buffer.active.baseY = 21;
      term.buffer.active.viewportY = 20;
      listener(20);
    }

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={nextContent}
        contentByteCount={nextContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).toHaveBeenCalled();
  });

  it('preserves the viewport through a reset-classified live update while paused', async () => {
    const initialContent = Array.from({ length: 44 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = Array.from({ length: 44 }, (_, index) => `line ${index + 2}`).join('\n');
    const appendedContent = `${nextContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });
    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    term.reset.mockClear();
    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();
    term.write.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalledTimes(1);
      expect(term.scrollToLine).toHaveBeenCalled();
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    term.write.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={appendedContent}
          contentByteCount={appendedContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('restores the latest paused viewport after reset-preserve when streamed output lands before capture runs', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = Array.from({ length: 48 }, (_, index) => `line ${index + 2}`).join('\n');
    const appendedContent = `${nextContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const queuedRaf = installQueuedRaf();
    try {
      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={nextContent}
            contentByteCount={nextContent.length}
            contentGeneration={1}
            readOnly={false}
            inputEnabled
          />
        );
      });

      await waitFor(() => {
        expect(term.reset).toHaveBeenCalledTimes(1);
        expect(term.scrollToLine).toHaveBeenCalledWith(16);
      });

      setViewportMetrics(viewport as HTMLElement, {
        clientHeight: 200,
        scrollHeight: 1240,
        scrollTop: 640
      });
      term.buffer.active.baseY = 20;
      term.buffer.active.viewportY = 12;

      const originalWrite = term.write.getMockImplementation();
      term.write.mockImplementation((chunk: string, callback?: () => void) => {
        originalWrite?.(chunk, () => {
          if (chunk === '\nnext streamed line') {
            term.buffer.active.baseY = 20;
            term.buffer.active.viewportY = 14;
            setViewportMetrics(viewport as HTMLElement, {
              clientHeight: 200,
              scrollHeight: 1280,
              scrollTop: 680
            });
            fireEvent.scroll(viewport as HTMLElement);
          }
          callback?.();
        });
      });

      term.write.mockClear();
      term.scrollToBottom.mockClear();

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={appendedContent}
            contentByteCount={appendedContent.length}
            contentGeneration={1}
            readOnly={false}
            inputEnabled
          />
        );
      });

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      });
      expect((viewport as HTMLElement).scrollTop).toBe(680);

      await act(async () => {
        queuedRaf.flush();
      });

      expect((viewport as HTMLElement).scrollTop).toBe(640);
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });

  it('does not rerender the active terminal for unrelated parent state churn when props are stable', async () => {
    const streamState = {
      sessionId: 'session-1',
      text: 'line 1\nline 2\n',
      startPosition: 0,
      endPosition: 14,
      truncated: false,
      phase: 'live' as const,
      resetToken: 0
    };

    const onData = vi.fn();
    const onResize = vi.fn();
    const onFocusChange = vi.fn();

    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={streamState}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        focusRequestId={0}
        repairRequestId={0}
        searchToggleRequestId={0}
        onData={onData}
        onResize={onResize}
        onFocusChange={onFocusChange}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    term.scrollToBottom.mockClear();
    term.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={streamState}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
        focusRequestId={0}
        repairRequestId={0}
        searchToggleRequestId={0}
        onData={onData}
        onResize={onResize}
        onFocusChange={onFocusChange}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.terminals).toHaveLength(1);
    expect(term.write).not.toHaveBeenCalled();
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('restores a paused viewport after a write-induced native scroll drift', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    const originalWrite = term.write.getMockImplementation();
    term.write.mockImplementation((chunk: string, callback?: () => void) => {
      originalWrite?.(chunk, () => {
        if (chunk === '\nnext streamed line') {
          setViewportMetrics(viewport as HTMLElement, {
            clientHeight: 200,
            scrollHeight: 1240,
            scrollTop: 640
          });
          fireEvent.scroll(viewport as HTMLElement);
        }
        callback?.();
      });
    });

    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();
    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={0}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      expect(term.scrollToLine).toHaveBeenCalled();
      expect((viewport as HTMLElement).scrollTop).toBe(640);
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('updates the paused viewport snapshot from an overlay scrollbar drag', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600,
      clientWidth: 400,
      offsetWidth: 400
    });
    Object.defineProperty(viewport as HTMLElement, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: 0,
          top: 0,
          right: 400,
          bottom: 200,
          width: 400,
          height: 200,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) satisfies DOMRect
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    await act(async () => {
      fireEvent.pointerDown(viewport as HTMLElement, { clientX: 392 });
      setViewportMetrics(viewport as HTMLElement, {
        clientHeight: 200,
        scrollHeight: 1200,
        scrollTop: 400,
        clientWidth: 400,
        offsetWidth: 400
      });
      fireEvent.scroll(viewport as HTMLElement);
      fireEvent.pointerUp(viewport as HTMLElement, { clientX: 392 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    const originalWrite = term.write.getMockImplementation();
    term.write.mockImplementation((chunk: string, callback?: () => void) => {
      originalWrite?.(chunk, () => {
        if (chunk === '\nnext streamed line') {
          setViewportMetrics(viewport as HTMLElement, {
            clientHeight: 200,
            scrollHeight: 1240,
            scrollTop: 440,
            clientWidth: 400,
            offsetWidth: 400
          });
          fireEvent.scroll(viewport as HTMLElement);
        }
        callback?.();
      });
    });

    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();
    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={0}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      expect(term.scrollToLine).toHaveBeenCalled();
      expect((viewport as HTMLElement).scrollTop).toBe(440);
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('preserves a native off-bottom viewport position through reset when xterm viewportY is still stale', async () => {
    const initialContent = Array.from({ length: 44 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = Array.from({ length: 44 }, (_, index) => `line ${index + 2}`).join('\n');
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    term.reset.mockClear();
    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalledTimes(1);
      expect(term.scrollToLine).toHaveBeenCalledWith(12);
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('prefers a smaller DOM scrollback offset when the user scrolls back down before reset', async () => {
    const initialContent = Array.from({ length: 44 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = Array.from({ length: 44 }, (_, index) => `line ${index + 2}`).join('\n');
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 800
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    term.reset.mockClear();
    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalledTimes(1);
      expect(term.scrollToLine).toHaveBeenCalledWith(16);
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('does not auto-resume follow from reset-induced scroll events during a paused bulk replay', async () => {
    const initialContent = Array.from({ length: 44 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = Array.from({ length: 44 }, (_, index) => `line ${index + 2}`).join('\n');
    const appendedContent = `${nextContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });
    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    term.reset.mockClear();
    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalledTimes(1);
      expect(term.scrollToLine).toHaveBeenCalledWith(12);
    });

    term.scrollToBottom.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={appendedContent}
          contentByteCount={appendedContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('does not auto-follow after a paused reset replay that finishes after the scroll cooldown', async () => {
    const initialContent = Array.from({ length: 44 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = Array.from({ length: 44 }, (_, index) => `line ${index + 2}`).join('\n');
    const appendedContent = `${nextContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const originalWrite = term.write.getMockImplementation();
    let delayedReplay = true;
    term.write.mockImplementation((chunk: string, callback?: () => void) => {
      if (delayedReplay && chunk === nextContent) {
        delayedReplay = false;
        originalWrite?.(chunk, () => {
          window.setTimeout(() => {
            callback?.();
          }, 170);
        });
        return;
      }
      originalWrite?.(chunk, callback);
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });
    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    term.reset.mockClear();
    term.scrollToBottom.mockClear();

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalledTimes(1);
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();

    term.write.mockClear();
    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={appendedContent}
          contentByteCount={appendedContent.length}
          contentGeneration={1}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('does not resume follow from a programmatic scroll-to-bottom while paused', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    await act(async () => {
      for (const listener of term.onScrollListeners) {
        listener(20);
      }
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 170));
    });

    term.scrollToBottom.mockClear();
    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={nextContent}
          contentByteCount={nextContent.length}
          contentGeneration={0}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('resumes follow when the user scrolls back to bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 19;
    term.scrollToBottom.mockClear();
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: 32 });
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 170));
    });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={nextContent}
        contentByteCount={nextContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).toHaveBeenCalled();
  });

  it('keeps a downward wheel resume armed across paused viewport scroll events until xterm reaches bottom', async () => {
    const initialContent = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${initialContent}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={initialContent}
        contentByteCount={initialContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialContent, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    await waitFor(() => {
      expect(container.querySelector('.terminal-follow-button')).not.toBeNull();
    });

    viewport!.dataset.skipXtermWheel = 'true';
    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 19;
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      value: 200
    });
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 1200
    });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 980
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: 32 });
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 20;
    await act(async () => {
      for (const listener of term.onScrollListeners) {
        listener(20);
      }
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 170));
    });

    term.scrollToBottom.mockClear();
    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={nextContent}
        contentByteCount={nextContent.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
    });
    expect(term.scrollToBottom).toHaveBeenCalled();
  });

  it('keeps the final terminal instance consistent across repeated repair requests', async () => {
    const content = 'line 1\nline 2\nline 3';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );
    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={2}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals.length).toBeGreaterThanOrEqual(2);
    });

    const finalTerm = mocks.terminals[mocks.terminals.length - 1];
    await waitFor(() => {
      expect(finalTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    finalTerm.write.mockClear();
    finalTerm.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={`${content}\nline 4`}
        readOnly={false}
        inputEnabled
        repairRequestId={2}
      />
    );

    await waitFor(() => {
      expect(finalTerm.write).toHaveBeenCalledWith('\nline 4', expect.any(Function));
      expect(finalTerm.reset).not.toHaveBeenCalled();
    });
  });

  it('replays the visible suffix instead of resetting when pending chunk coverage trims ahead of the renderer', async () => {
    const initialStreamState = {
      sessionId: 'session-1',
      phase: 'ready' as const,
      text: 'abcdef',
      rawEndPosition: 6,
      startPosition: 0,
      endPosition: 6,
      chunks: [],
      resetToken: 1
    };
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
      expect(term.write).toHaveBeenCalledWith(initialStreamState.text, expect.any(Function));
    });

    term.write.mockClear();
    term.reset.mockClear();

    const nextStreamState = {
      ...initialStreamState,
      text: 'cdefghij',
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
      ]
    };

    rerender(
      <TerminalPanel
        sessionId="session-1"
        streamState={nextStreamState}
        content={nextStreamState.text}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('ghij', expect.any(Function));
      expect(term.reset).not.toHaveBeenCalled();
    });
  });

  it('preserves a paused viewport through a streamState resetToken replay', async () => {
    const initialText = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const resetText = Array.from({ length: 48 }, (_, index) => `line ${index + 2}`).join('\n');
    const appendedText = `${resetText}\nnext streamed line`;
    const initialStreamState = {
      sessionId: 'session-1',
      phase: 'ready' as const,
      text: initialText,
      rawEndPosition: initialText.length,
      startPosition: 0,
      endPosition: initialText.length,
      chunks: [],
      resetToken: 0
    };
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={initialStreamState}
        content={initialText}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialText, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    term.reset.mockClear();
    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();

    const queuedRaf = installQueuedRaf();
    try {
      const resetStreamState = {
        ...initialStreamState,
        text: resetText,
        rawEndPosition: resetText.length,
        endPosition: resetText.length,
        resetToken: 1
      };

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            streamState={resetStreamState}
            content={resetText}
            readOnly={false}
            inputEnabled
          />
        );
      });

      await waitFor(() => {
        expect(term.reset).toHaveBeenCalledTimes(1);
        expect(term.scrollToLine).toHaveBeenCalledWith(16);
      });

      setViewportMetrics(viewport as HTMLElement, {
        clientHeight: 200,
        scrollHeight: 1240,
        scrollTop: 640
      });
      term.buffer.active.baseY = 24;
      term.buffer.active.viewportY = 16;

      const originalWrite = term.write.getMockImplementation();
      term.write.mockImplementation((chunk: string, callback?: () => void) => {
        originalWrite?.(chunk, () => {
          if (chunk === '\nnext streamed line') {
            term.buffer.active.baseY = 24;
            term.buffer.active.viewportY = 18;
            setViewportMetrics(viewport as HTMLElement, {
              clientHeight: 200,
              scrollHeight: 1280,
              scrollTop: 680
            });
            fireEvent.scroll(viewport as HTMLElement);
          }
          callback?.();
        });
      });

      term.write.mockClear();
      term.scrollToBottom.mockClear();

      const appendedStreamState = {
        ...resetStreamState,
        text: appendedText,
        rawEndPosition: appendedText.length,
        endPosition: appendedText.length,
        chunks: [
          {
            rawStartPosition: resetText.length,
            rawEndPosition: appendedText.length,
            startPosition: resetText.length,
            endPosition: appendedText.length,
            data: '\nnext streamed line'
          }
        ]
      };

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            streamState={appendedStreamState}
            content={appendedText}
            readOnly={false}
            inputEnabled
          />
        );
      });

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      });
      expect((viewport as HTMLElement).scrollTop).toBe(680);

      await act(async () => {
        queuedRaf.flush();
      });

      expect((viewport as HTMLElement).scrollTop).toBe(640);
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });

  it('keeps paused follow through a streamState pending-gap reset fallback', async () => {
    const initialText = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const resetText = Array.from({ length: 48 }, (_, index) => `future line ${index + 1}`).join('\n');
    const initialStreamState = {
      sessionId: 'session-1',
      phase: 'ready' as const,
      text: initialText,
      rawEndPosition: initialText.length,
      startPosition: 0,
      endPosition: initialText.length,
      chunks: [],
      resetToken: 0
    };
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={initialStreamState}
        content={initialText}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialText, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    term.reset.mockClear();
    term.scrollToBottom.mockClear();
    term.scrollToLine.mockClear();

    const gapStart = initialText.length + 10;
    const gapEnd = gapStart + resetText.length;
    const gapStreamState = {
      ...initialStreamState,
      text: resetText,
      rawEndPosition: gapEnd,
      startPosition: gapStart,
      endPosition: gapEnd,
      chunks: [
        {
          rawStartPosition: gapEnd - 4,
          rawEndPosition: gapEnd,
          startPosition: gapEnd - 4,
          endPosition: gapEnd,
          data: resetText.slice(-4)
        }
      ]
    };

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          streamState={gapStreamState}
          content={resetText}
          readOnly={false}
          inputEnabled
        />
      );
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalledTimes(1);
      expect(term.write).toHaveBeenCalledWith(resetText, expect.any(Function));
      expect(term.scrollToLine).toHaveBeenCalledWith(16);
    });
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('restores a paused viewport after a streamState visible-suffix replay write', async () => {
    const initialText = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const appendedText = `${initialText.slice(4)}\nnext streamed line`;
    const initialStreamState = {
      sessionId: 'session-1',
      phase: 'ready' as const,
      text: initialText,
      rawEndPosition: initialText.length,
      startPosition: 0,
      endPosition: initialText.length,
      chunks: [],
      resetToken: 0
    };
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        streamState={initialStreamState}
        content={initialText}
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const term = mocks.terminals[0];
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(initialText, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.wheel(viewport as HTMLElement, { deltaY: -32 });
    });

    term.buffer.active.baseY = 20;
    term.buffer.active.viewportY = 12;

    const originalWrite = term.write.getMockImplementation();
    term.write.mockImplementation((chunk: string, callback?: () => void) => {
      originalWrite?.(chunk, () => {
        if (chunk === '\nnext streamed line') {
          term.buffer.active.baseY = 20;
          term.buffer.active.viewportY = 14;
          setViewportMetrics(viewport as HTMLElement, {
            clientHeight: 200,
            scrollHeight: 1240,
            scrollTop: 640
          });
          fireEvent.scroll(viewport as HTMLElement);
        }
        callback?.();
      });
    });

    term.write.mockClear();
    term.reset.mockClear();
    term.scrollToBottom.mockClear();

    const queuedRaf = installQueuedRaf();
    try {
      const nextStreamState = {
        ...initialStreamState,
        text: appendedText,
        rawEndPosition: initialText.length + '\nnext streamed line'.length,
        startPosition: 4,
        endPosition: initialText.length + '\nnext streamed line'.length,
        chunks: [
          {
            rawStartPosition: initialText.length + '\nnext streamed line'.length - 4,
            rawEndPosition: initialText.length + '\nnext streamed line'.length,
            startPosition: initialText.length + '\nnext streamed line'.length - 4,
            endPosition: initialText.length + '\nnext streamed line'.length,
            data: 'line'
          }
        ]
      };

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            streamState={nextStreamState}
            content={appendedText}
            readOnly={false}
            inputEnabled
          />
        );
      });

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      });
      expect((viewport as HTMLElement).scrollTop).toBe(640);

      await act(async () => {
        queuedRaf.flush();
      });

      expect((viewport as HTMLElement).scrollTop).toBe(600);
      expect(term.reset).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });

  it('captures a native off-bottom viewport position for manual repair even before xterm onScroll catches up', async () => {
    const content = Array.from({ length: 44 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        contentByteCount={content.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();

    firstTerm.buffer.active.baseY = 20;
    firstTerm.buffer.active.viewportY = 20;
    setViewportMetrics(viewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.scroll(viewport as HTMLElement);
    });

    firstTerm.buffer.active.baseY = 20;
    firstTerm.buffer.active.viewportY = 20;

    await act(async () => {
      rerender(
        <TerminalPanel
          sessionId="session-1"
          content={content}
          contentByteCount={content.length}
          contentGeneration={0}
          readOnly={false}
          inputEnabled
          repairRequestId={1}
        />
      );
    });

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(2);
    });

    const repairedTerm = mocks.terminals[1];
    await waitFor(() => {
      expect(repairedTerm.scrollToLine).toHaveBeenCalledWith(12);
    });
  });

  it('restores the paused viewport when streamed output lands before replay-preserve capture runs', async () => {
    const content = Array.from({ length: 48 }, (_, index) => `line ${index + 1}`).join('\n');
    const nextContent = `${content}\nnext streamed line`;
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        contentByteCount={content.length}
        contentGeneration={0}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    const firstViewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    expect(firstViewport).not.toBeNull();

    firstTerm.buffer.active.baseY = 20;
    firstTerm.buffer.active.viewportY = 12;
    setViewportMetrics(firstViewport as HTMLElement, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 600
    });

    await act(async () => {
      fireEvent.wheel(firstViewport as HTMLElement, { deltaY: -32 });
    });

    firstTerm.buffer.active.baseY = 20;
    firstTerm.buffer.active.viewportY = 12;

    const queuedRaf = installQueuedRaf();
    try {
      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={content}
            contentByteCount={content.length}
            contentGeneration={0}
            readOnly={false}
            inputEnabled
            repairRequestId={1}
          />
        );
      });

      await waitFor(() => {
        expect(mocks.terminals).toHaveLength(2);
      });

      const repairedTerm = mocks.terminals[1];
      await waitFor(() => {
        expect(repairedTerm.scrollToLine).toHaveBeenCalled();
      });

      const repairedViewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
      expect(repairedViewport).not.toBeNull();
      setViewportMetrics(repairedViewport as HTMLElement, {
        clientHeight: 200,
        scrollHeight: 1200,
        scrollTop: 600
      });
      repairedTerm.buffer.active.baseY = 20;
      repairedTerm.buffer.active.viewportY = 12;

      const originalWrite = repairedTerm.write.getMockImplementation();
      repairedTerm.write.mockImplementation((chunk: string, callback?: () => void) => {
        originalWrite?.(chunk, () => {
          if (chunk === '\nnext streamed line') {
            repairedTerm.buffer.active.baseY = 20;
            repairedTerm.buffer.active.viewportY = 14;
            setViewportMetrics(repairedViewport as HTMLElement, {
              clientHeight: 200,
              scrollHeight: 1240,
              scrollTop: 640
            });
            fireEvent.scroll(repairedViewport as HTMLElement);
          }
          callback?.();
        });
      });

      repairedTerm.write.mockClear();
      repairedTerm.scrollToBottom.mockClear();

      await act(async () => {
        rerender(
          <TerminalPanel
            sessionId="session-1"
            content={nextContent}
            contentByteCount={nextContent.length}
            contentGeneration={0}
            readOnly={false}
            inputEnabled
            repairRequestId={1}
          />
        );
      });

      await waitFor(() => {
        expect(repairedTerm.write).toHaveBeenCalledWith('\nnext streamed line', expect.any(Function));
      });
      expect((repairedViewport as HTMLElement).scrollTop).toBe(640);

      await act(async () => {
        queuedRaf.flush();
      });

      expect((repairedViewport as HTMLElement).scrollTop).toBe(600);
      expect(repairedTerm.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      queuedRaf.restore();
    }
  });
});
