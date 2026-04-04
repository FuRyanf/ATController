import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DECTCEM_HIDE = '\u001b[?25l';
const DECTCEM_SHOW = '\u001b[?25h';

let resizeObserverCallback: ResizeObserverCallback | null = null;

const mocks = vi.hoisted(() => {
  const fit = vi.fn();
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
    dispose: vi.fn()
  }))
}));

vi.mock('xterm-addon-web-links', () => ({
  WebLinksAddon: vi.fn(() => ({}))
}));

import { TerminalPanel } from '../../src/components/TerminalPanel';

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
      expect(firstTerm.reset).toHaveBeenCalled();
      expect(firstTerm.write).toHaveBeenCalledWith(DECTCEM_HIDE);
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

  it('pauses follow when the viewport scrolls off-bottom without a wheel event', async () => {
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

    await waitFor(() => {
      expect(container.querySelector('.terminal-follow-button')).not.toBeNull();
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
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('resumes follow and keeps the viewport at latest when the user types while paused', async () => {
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

    await waitFor(() => {
      expect(container.querySelector('.terminal-follow-button')).not.toBeNull();
    });

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
      expect(term.scrollToLine).toHaveBeenCalledWith(12);
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
      expect(term.scrollToLine).toHaveBeenCalledWith(14);
      expect((viewport as HTMLElement).scrollTop).toBe(600);
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
      expect(term.scrollToLine).toHaveBeenCalledWith(10);
      expect((viewport as HTMLElement).scrollTop).toBe(400);
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
});
