import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const searchAddons: Array<{
    activate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    findNext: ReturnType<typeof vi.fn>;
    findPrevious: ReturnType<typeof vi.fn>;
    clearDecorations: ReturnType<typeof vi.fn>;
    clearActiveDecoration: ReturnType<typeof vi.fn>;
    emitResults: (resultIndex: number, resultCount: number) => void;
    onDidChangeResults: (listener: (event: { resultIndex: number; resultCount: number }) => void) => { dispose: () => void };
  }> = [];

  const createSearchAddon = () => {
    let listener: ((event: { resultIndex: number; resultCount: number }) => void) | null = null;
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      findNext: vi.fn((term: string) => {
        listener?.({ resultIndex: term ? 0 : -1, resultCount: term ? 3 : 0 });
        return Boolean(term);
      }),
      findPrevious: vi.fn((term: string) => {
        listener?.({ resultIndex: term ? 1 : -1, resultCount: term ? 3 : 0 });
        return Boolean(term);
      }),
      clearDecorations: vi.fn(() => {
        listener?.({ resultIndex: -1, resultCount: 0 });
      }),
      clearActiveDecoration: vi.fn(),
      emitResults: (resultIndex: number, resultCount: number) => {
        listener?.({ resultIndex, resultCount });
      },
      onDidChangeResults: (nextListener: (event: { resultIndex: number; resultCount: number }) => void) => {
        listener = nextListener;
        return {
          dispose: () => {
            if (listener === nextListener) {
              listener = null;
            }
          }
        };
      }
    };
    searchAddons.push(addon);
    return addon;
  };

  const terminals: Array<{
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onScroll: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
    scrollToLine: ReturnType<typeof vi.fn>;
    scrollLines: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    buffer: {
      active: {
        baseY: number;
        viewportY: number;
        cursorY: number;
        getLine: (row: number) => undefined;
      };
    };
  }> = [];
  const terminalOptions: Array<Record<string, unknown>> = [];

  const createTerminal = (options: Record<string, unknown> = {}) => {
    terminalOptions.push(options);
    const term = {
      open: vi.fn((host: HTMLElement) => {
        const viewport = document.createElement('div');
        viewport.className = 'xterm-viewport';
        host.appendChild(viewport);
        const textarea = document.createElement('textarea');
        textarea.className = 'xterm-helper-textarea';
        host.appendChild(textarea);
      }),
      loadAddon: vi.fn((addon: { activate?: (terminal: unknown) => void }) => {
        addon.activate?.(term);
      }),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn((_chunk: string, callback?: () => void) => {
        callback?.();
      }),
      refresh: vi.fn(),
      resize: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      scrollLines: vi.fn(),
      clearSelection: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn(),
      options: {},
      cols: 120,
      rows: 32,
      buffer: {
        active: {
          baseY: 0,
          viewportY: 0,
          cursorY: 0,
          getLine: () => undefined
        }
      }
    };
    terminals.push(term);
    return term;
  };

  return {
    searchAddons,
    createSearchAddon,
    terminals,
    terminalOptions,
    createTerminal,
    fit: vi.fn()
  };
});

vi.mock('../../src/lib/api', () => ({
  api: {
    openExternalUrl: vi.fn(async () => undefined)
  }
}));

vi.mock('xterm', () => ({
  Terminal: vi.fn((options: Record<string, unknown>) => mocks.createTerminal(options))
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: mocks.fit,
    proposeDimensions: () => ({ cols: 120, rows: 32 }),
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

describe('TerminalPanel search', () => {
  beforeEach(() => {
    (globalThis as { __CLAUDEX_ENABLE_XTERM_TESTS__?: boolean }).__CLAUDEX_ENABLE_XTERM_TESTS__ = true;
    mocks.fit.mockClear();
    mocks.searchAddons.length = 0;
    mocks.terminals.length = 0;
    mocks.terminalOptions.length = 0;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as typeof ResizeObserver;
  });

  afterEach(() => {
    delete (globalThis as { __CLAUDEX_ENABLE_XTERM_TESTS__?: boolean }).__CLAUDEX_ENABLE_XTERM_TESTS__;
  });

  it('toggles search UI and drives the xterm search addon', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TerminalPanel sessionId="session-1" content="alpha needle beta needle" searchToggleRequestId={0} />
    );

    await waitFor(() => {
      expect(mocks.searchAddons).toHaveLength(1);
    });
    expect(mocks.terminalOptions[0]).toEqual(expect.objectContaining({ allowProposedApi: true }));

    rerender(<TerminalPanel sessionId="session-1" content="alpha needle beta needle" searchToggleRequestId={1} />);

    const input = await screen.findByTestId('terminal-search-input');
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    await user.type(input, 'needle');

    await waitFor(() => {
      expect(mocks.searchAddons[0].findNext).toHaveBeenCalledWith(
        'needle',
        expect.objectContaining({
          incremental: true,
          decorations: expect.any(Object)
        })
      );
    });
    expect(screen.getByTestId('terminal-search-count')).toHaveTextContent('1 / 3');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.searchAddons[0].findNext).toHaveBeenLastCalledWith(
      'needle',
      expect.objectContaining({ incremental: false })
    );

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(mocks.searchAddons[0].findPrevious).toHaveBeenLastCalledWith(
      'needle',
      expect.objectContaining({ incremental: false })
    );

    rerender(<TerminalPanel sessionId="session-1" content="alpha needle beta needle" searchToggleRequestId={2} />);

    await waitFor(() => {
      expect(screen.queryByTestId('terminal-search-input')).not.toBeInTheDocument();
    });
    expect(mocks.searchAddons[0].clearDecorations).toHaveBeenCalled();
  });

  it('disables browser text assistance on the xterm helper textarea', async () => {
    const { container } = render(<TerminalPanel sessionId="session-1" content="" />);

    await waitFor(() => {
      expect(container.querySelector('textarea.xterm-helper-textarea')).not.toBeNull();
    });

    const textarea = container.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement;
    expect(textarea.spellcheck).toBe(false);
    expect(textarea).toHaveAttribute('spellcheck', 'false');
    expect(textarea).toHaveAttribute('autocomplete', 'off');
    expect(textarea).toHaveAttribute('autocorrect', 'off');
    expect(textarea).toHaveAttribute('autocapitalize', 'off');
    expect(textarea).toHaveAttribute('aria-autocomplete', 'none');
    expect(textarea).toHaveAttribute('data-gramm', 'false');
  });
});
