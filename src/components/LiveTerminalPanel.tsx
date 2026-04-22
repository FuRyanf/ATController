import React, { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent } from 'react';

import 'xterm/css/xterm.css';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon, type ISearchOptions } from 'xterm-addon-search';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { Terminal } from 'xterm';
import { api } from '../lib/api';
import type { TerminalSessionStreamState } from '../lib/terminalSessionStream';
import { looksLikeStatefulTerminalUi } from '../lib/terminalUiHeuristics';
import { normalizeTerminalScrollbackLines, TERMINAL_SCROLLBACK_LINES_DEFAULT } from '../types';

const VIEWPORT_OFF_BOTTOM_THRESHOLD_LINES = 0;
const PROGRAMMATIC_SCROLL_SUPPRESSION_MS = 220;
const USER_SCROLL_PAUSE_COOLDOWN_MS = 220;
const MULTILINE_ENTER_SEQUENCE = '\x1b\r';
const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 500;
const DECTCEM_HIDE = '\x1b[?25l';
const DECTCEM_SHOW = '\x1b[?25h';
const TERMINAL_TEXTAREA_SELECTOR = 'textarea.xterm-helper-textarea, textarea';
const TERMINAL_SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#27415d',
  matchBorder: '#5e83b5',
  matchOverviewRuler: '#4f79ac',
  activeMatchBackground: '#8fb7ff',
  activeMatchBorder: '#d6e6ff',
  activeMatchColorOverviewRuler: '#8fb7ff'
};

interface LiveTerminalPanelProps {
  sessionId?: string | null;
  streamState?: TerminalSessionStreamState | null;
  scrollbackLines?: number;
  readOnly?: boolean;
  inputEnabled?: boolean;
  cursorVisible?: boolean;
  overlayMessage?: string;
  preferLiveRedrawOnMount?: boolean;
  focusRequestId?: number;
  repairRequestId?: number;
  searchToggleRequestId?: number;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onFocusChange?: (focused: boolean) => void;
  onFollowOutputPausedChange?: (paused: boolean) => void;
}

function hardenTerminalTextInput(host: HTMLElement) {
  const textareas = host.querySelectorAll<HTMLTextAreaElement>(TERMINAL_TEXTAREA_SELECTOR);
  for (const textarea of textareas) {
    textarea.spellcheck = false;
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('aria-autocomplete', 'none');
    textarea.setAttribute('data-gramm', 'false');
    textarea.setAttribute('data-gramm_editor', 'false');
    textarea.setAttribute('data-enable-grammarly', 'false');
  }
}

function isNearBottom(term: Terminal): boolean {
  return term.buffer.active.baseY - term.buffer.active.viewportY <= VIEWPORT_OFF_BOTTOM_THRESHOLD_LINES;
}

function captureScrollbackOffset(term: Terminal): number {
  return Math.max(0, term.buffer.active.baseY - term.buffer.active.viewportY);
}

function restoreScrollbackOffset(term: Terminal, offset: number) {
  const targetLine = Math.max(0, term.buffer.active.baseY - offset);
  term.scrollToLine(targetLine);
}

function openExternalLink(event: MouseEvent, uri: string) {
  event.preventDefault();
  void api.openExternalUrl(uri);
}

function writeTerminalChunk(term: Terminal, chunk: string, callback?: () => void) {
  if (!chunk) {
    callback?.();
    return;
  }
  term.write(chunk, () => {
    callback?.();
  });
}

function writeTerminalChunkAsync(term: Terminal, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    writeTerminalChunk(term, chunk, resolve);
  });
}

export function LiveTerminalPanel({
  sessionId = null,
  streamState = null,
  scrollbackLines = TERMINAL_SCROLLBACK_LINES_DEFAULT,
  readOnly = false,
  inputEnabled = true,
  cursorVisible = true,
  overlayMessage,
  preferLiveRedrawOnMount = false,
  focusRequestId = 0,
  repairRequestId = 0,
  searchToggleRequestId = 0,
  onData,
  onResize,
  onFocusChange,
  onFollowOutputPausedChange
}: LiveTerminalPanelProps) {
  const normalizedScrollbackLines = normalizeTerminalScrollbackLines(scrollbackLines);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchDecorationsEnabledRef = useRef(true);
  const streamStateRef = useRef(streamState);
  const replayWriteChainRef = useRef(Promise.resolve());
  const renderedResetTokenRef = useRef(streamState?.resetToken ?? 0);
  const renderedEndPositionRef = useRef(streamState?.endPosition ?? 0);
  const renderedTextRef = useRef(streamState?.text ?? '');
  const renderedSessionIdRef = useRef(streamState?.sessionId ?? sessionId ?? null);
  const resetReplayEpochRef = useRef(0);
  const pendingStatefulResizeDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimeoutRef = useRef<number | null>(null);
  const programmaticScrollSuppressUntilRef = useRef(0);
  const userScrollPauseCooldownUntilRef = useRef(0);
  const preservingViewportDuringReplayRef = useRef(false);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onFocusChangeRef = useRef(onFocusChange);
  const onFollowOutputPausedChangeRef = useRef(onFollowOutputPausedChange);
  const sessionIdRef = useRef(sessionId);
  const readOnlyRef = useRef(readOnly);
  const inputEnabledRef = useRef(inputEnabled);
  const cursorVisibleRef = useRef(cursorVisible);
  const previousCursorVisibleRef = useRef(cursorVisible);
  const previousRepairRequestRef = useRef(repairRequestId);
  const previousSearchToggleRequestRef = useRef(searchToggleRequestId);
  const [followOutputPaused, setFollowOutputPaused] = useState(false);
  const followOutputPausedRef = useRef(false);
  const previousFollowOutputPausedRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResultCount, setSearchResultCount] = useState(0);
  const [searchResultIndex, setSearchResultIndex] = useState(-1);

  const searchResultLabel = useMemo(
    () =>
      searchResultCount > 0
        ? `${Math.max(1, searchResultIndex + 1)} / ${searchResultCount}`
        : searchQuery
          ? '0 results'
          : 'Find',
    [searchQuery, searchResultCount, searchResultIndex]
  );

  const syncFollowOutputPaused = useCallback((paused: boolean) => {
    followOutputPausedRef.current = paused;
    setFollowOutputPaused((current) => (current === paused ? current : paused));
  }, []);

  const armUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    if (userScrollIntentTimeoutRef.current !== null) {
      window.clearTimeout(userScrollIntentTimeoutRef.current);
    }
    userScrollIntentTimeoutRef.current = window.setTimeout(() => {
      userScrollIntentTimeoutRef.current = null;
      userScrollIntentRef.current = false;
    }, 160);
  }, []);

  const armUserScrollPauseCooldown = useCallback(() => {
    userScrollPauseCooldownUntilRef.current = Date.now() + USER_SCROLL_PAUSE_COOLDOWN_MS;
  }, []);

  const pauseFollowForUserScroll = useCallback(() => {
    armUserScrollPauseCooldown();
    syncFollowOutputPaused(true);
  }, [armUserScrollPauseCooldown, syncFollowOutputPaused]);

  const notifyResizeIfChanged = useCallback((term: Terminal, nextSizeOverride?: { cols: number; rows: number }) => {
    const nextSize = nextSizeOverride ?? { cols: term.cols, rows: term.rows };
    const previousSize = lastReportedSizeRef.current;
    if (previousSize?.cols === nextSize.cols && previousSize?.rows === nextSize.rows) {
      return;
    }
    lastReportedSizeRef.current = nextSize;
    onResizeRef.current?.(nextSize.cols, nextSize.rows);
  }, []);

  const scrollToLatest = useCallback((term: Terminal, options: { force?: boolean } = {}) => {
    if (!options.force && Date.now() < userScrollPauseCooldownUntilRef.current) {
      return;
    }
    programmaticScrollSuppressUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_SUPPRESSION_MS;
    term.scrollToBottom();
    syncFollowOutputPaused(false);
  }, [syncFollowOutputPaused]);

  const enqueueTerminalMutation = useCallback((
    term: Terminal,
    mutate: () => Promise<void> | void,
    options: { resetEpoch?: number | null } = {}
  ) => {
    const expectedResetEpoch = options.resetEpoch ?? null;
    const runMutation = async () => {
      if (terminalRef.current !== term) {
        return;
      }
      if (expectedResetEpoch !== null && resetReplayEpochRef.current !== expectedResetEpoch) {
        return;
      }
      await mutate();
    };
    replayWriteChainRef.current = replayWriteChainRef.current.then(runMutation, runMutation);
  }, []);

  const applyLocalResize = useCallback((
    term: Terminal,
    dims: { cols: number; rows: number } | null | undefined,
    options: { report?: boolean } = {}
  ) => {
    if (!dims) {
      return;
    }
    const nextCols = Math.max(1, dims.cols);
    const nextRows = Math.max(1, dims.rows);
    const preserveOffset = followOutputPausedRef.current ? captureScrollbackOffset(term) : 0;
    const sizeChanged = term.cols !== nextCols || term.rows !== nextRows;
    if (sizeChanged) {
      programmaticScrollSuppressUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_SUPPRESSION_MS;
      term.resize(nextCols, nextRows);
    }
    if (followOutputPausedRef.current && preserveOffset > 0) {
      restoreScrollbackOffset(term, preserveOffset);
    } else {
      term.scrollToBottom();
    }
    if (options.report) {
      notifyResizeIfChanged(term, { cols: nextCols, rows: nextRows });
    }
  }, [notifyResizeIfChanged]);

  const applyMeasuredResize = useCallback((term: Terminal, dims: { cols: number; rows: number } | null | undefined) => {
    if (!dims) {
      return;
    }
    const nextCols = Math.max(1, dims.cols);
    const nextRows = Math.max(1, dims.rows);
    const renderedText = streamStateRef.current?.text ?? renderedTextRef.current;
    const preserveAuthoritativeStatefulResize =
      preferLiveRedrawOnMount &&
      looksLikeStatefulTerminalUi(renderedText);
    const sizeChanged = term.cols !== nextCols || term.rows !== nextRows;
    if (preserveAuthoritativeStatefulResize && sizeChanged) {
      pendingStatefulResizeDimensionsRef.current = { cols: nextCols, rows: nextRows };
      notifyResizeIfChanged(term, { cols: nextCols, rows: nextRows });
      return;
    }
    pendingStatefulResizeDimensionsRef.current = null;
    applyLocalResize(term, { cols: nextCols, rows: nextRows }, { report: true });
  }, [applyLocalResize, notifyResizeIfChanged, preferLiveRedrawOnMount]);

  const applyQueuedStreamAdvance = useCallback((
    term: Terminal,
    nextStreamState: TerminalSessionStreamState,
    delta: string
  ) => {
    const expectedResetEpoch = resetReplayEpochRef.current;
    renderedSessionIdRef.current = nextStreamState.sessionId ?? sessionIdRef.current ?? null;
    renderedEndPositionRef.current = nextStreamState.endPosition;
    renderedTextRef.current = nextStreamState.text;
    enqueueTerminalMutation(term, async () => {
      if (delta.length > 0) {
        await writeTerminalChunkAsync(term, delta);
      }
      if (!followOutputPausedRef.current) {
        scrollToLatest(term);
      }
    }, { resetEpoch: expectedResetEpoch });
  }, [enqueueTerminalMutation, scrollToLatest]);

  const resetTerminalToSnapshot = useCallback((term: Terminal, nextStreamState: TerminalSessionStreamState | null) => {
    const nextText = nextStreamState?.text ?? '';
    const preserveOffset = followOutputPausedRef.current ? captureScrollbackOffset(term) : 0;
    const preserveViewport = followOutputPausedRef.current && preserveOffset > 0;
    const resetReplayEpoch = resetReplayEpochRef.current + 1;
    resetReplayEpochRef.current = resetReplayEpoch;
    renderedSessionIdRef.current = nextStreamState?.sessionId ?? sessionIdRef.current ?? null;
    renderedResetTokenRef.current = nextStreamState?.resetToken ?? 0;
    renderedEndPositionRef.current = nextStreamState?.endPosition ?? nextText.length;
    renderedTextRef.current = nextText;
    enqueueTerminalMutation(term, async () => {
      if (terminalRef.current !== term || resetReplayEpochRef.current !== resetReplayEpoch) {
        return;
      }
      preservingViewportDuringReplayRef.current = preserveViewport;
      programmaticScrollSuppressUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_SUPPRESSION_MS;
      try {
        term.reset();
        if (!cursorVisibleRef.current) {
          await writeTerminalChunkAsync(term, DECTCEM_HIDE);
        }
        if (nextText.length > 0) {
          await writeTerminalChunkAsync(term, nextText);
        }
        if (terminalRef.current !== term || resetReplayEpochRef.current !== resetReplayEpoch) {
          return;
        }
        if (preserveViewport) {
          restoreScrollbackOffset(term, preserveOffset);
          return;
        }
        scrollToLatest(term, { force: true });
      } finally {
        if (terminalRef.current === term && resetReplayEpochRef.current === resetReplayEpoch) {
          preservingViewportDuringReplayRef.current = false;
        }
      }
    }, { resetEpoch: resetReplayEpoch });
  }, [enqueueTerminalMutation, scrollToLatest]);

  const handleFollowOutputScroll = useCallback((term: Terminal) => {
    const isProgrammatic = Date.now() < programmaticScrollSuppressUntilRef.current;
    const atBottom = isNearBottom(term);
    if (isProgrammatic && !userScrollIntentRef.current) {
      if (preservingViewportDuringReplayRef.current) {
        return;
      }
      return;
    }
    if (atBottom) {
      syncFollowOutputPaused(false);
      return;
    }
    if (userScrollIntentRef.current || followOutputPausedRef.current) {
      syncFollowOutputPaused(true);
    }
  }, [syncFollowOutputPaused]);

  const clearSearchResults = useCallback(() => {
    searchAddonRef.current?.clearActiveDecoration?.();
    searchAddonRef.current?.clearDecorations?.();
    setSearchResultCount(0);
    setSearchResultIndex(-1);
  }, []);

  const runTerminalSearch = useCallback((query: string, direction: 'next' | 'previous', incremental = false) => {
    const addon = searchAddonRef.current;
    if (!addon) {
      return false;
    }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      clearSearchResults();
      return false;
    }

    const runWithOptions = (options: ISearchOptions) =>
      direction === 'previous'
        ? addon.findPrevious(normalizedQuery, options)
        : addon.findNext(normalizedQuery, options);

    try {
      return runWithOptions(
        searchDecorationsEnabledRef.current
          ? {
              incremental,
              decorations: TERMINAL_SEARCH_DECORATIONS
            }
          : { incremental }
      );
    } catch (error) {
      if (!searchDecorationsEnabledRef.current) {
        clearSearchResults();
        return false;
      }
      searchDecorationsEnabledRef.current = false;
      console.error('[terminal-search] disabling decorations after addon failure', error);
      setSearchResultCount(0);
      setSearchResultIndex(-1);

      try {
        return runWithOptions({ incremental });
      } catch (retryError) {
        console.error('[terminal-search] search failed', retryError);
        clearSearchResults();
        return false;
      }
    }
  }, [clearSearchResults]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    clearSearchResults();
  }, [clearSearchResults]);

  useEffect(() => {
    streamStateRef.current = streamState;
  }, [streamState]);

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onFocusChangeRef.current = onFocusChange;
  }, [onFocusChange]);

  useEffect(() => {
    onFollowOutputPausedChangeRef.current = onFollowOutputPausedChange;
  }, [onFollowOutputPausedChange]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    inputEnabledRef.current = inputEnabled;
    const term = terminalRef.current;
    if (term) {
      term.options.disableStdin = readOnly || !inputEnabled;
    }
  }, [inputEnabled, readOnly]);

  useEffect(() => {
    cursorVisibleRef.current = cursorVisible;
    const term = terminalRef.current;
    if (term && previousCursorVisibleRef.current !== cursorVisible) {
      writeTerminalChunk(term, cursorVisible ? DECTCEM_SHOW : DECTCEM_HIDE);
    }
    previousCursorVisibleRef.current = cursorVisible;
  }, [cursorVisible]);

  useEffect(() => {
    onFollowOutputPausedChangeRef.current?.(followOutputPaused);
  }, [followOutputPaused]);

  useEffect(() => {
    const wasPaused = previousFollowOutputPausedRef.current;
    previousFollowOutputPausedRef.current = followOutputPaused;
    if (!wasPaused || followOutputPaused) {
      return;
    }

    const term = terminalRef.current;
    const nextStreamState = streamStateRef.current;
    if (!term || !nextStreamState) {
      return;
    }
    const nextSessionId = nextStreamState.sessionId ?? sessionIdRef.current ?? null;
    if (nextSessionId !== sessionIdRef.current) {
      return;
    }
    if (
      !looksLikeStatefulTerminalUi(nextStreamState.text) &&
      !looksLikeStatefulTerminalUi(renderedTextRef.current)
    ) {
      return;
    }
    const staleSnapshot =
      renderedResetTokenRef.current !== nextStreamState.resetToken ||
      renderedEndPositionRef.current !== nextStreamState.endPosition ||
      renderedTextRef.current !== nextStreamState.text;
    if (!staleSnapshot) {
      return;
    }
    resetTerminalToSnapshot(term, nextStreamState);
  }, [followOutputPaused, resetTerminalToSnapshot]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !streamState) {
      return;
    }

    const nextSessionId = streamState.sessionId ?? sessionId ?? null;
    const statefulLiveScreen =
      Boolean(nextSessionId) &&
      (looksLikeStatefulTerminalUi(streamState.text) || looksLikeStatefulTerminalUi(renderedTextRef.current));
    const hasAuthoritativeStateAdvance =
      renderedResetTokenRef.current !== streamState.resetToken ||
      renderedEndPositionRef.current !== streamState.endPosition ||
      renderedTextRef.current !== streamState.text;
    const pendingStatefulResizeDimensions = pendingStatefulResizeDimensionsRef.current;
    if (pendingStatefulResizeDimensions && hasAuthoritativeStateAdvance) {
      applyLocalResize(term, pendingStatefulResizeDimensions);
      pendingStatefulResizeDimensionsRef.current = null;
    }

    if (followOutputPausedRef.current && statefulLiveScreen) {
      return;
    }

    if (renderedSessionIdRef.current !== nextSessionId) {
      renderedSessionIdRef.current = nextSessionId;
      resetTerminalToSnapshot(term, streamState);
      return;
    }

    if (renderedResetTokenRef.current !== streamState.resetToken) {
      resetTerminalToSnapshot(term, streamState);
      return;
    }

    if (streamState.phase !== 'ready') {
      return;
    }

    const pendingChunks = streamState.chunks.filter(
      (chunk) => chunk.endPosition > renderedEndPositionRef.current
    );
    if (pendingChunks.length === 0) {
      return;
    }

    const firstPendingChunk = pendingChunks[0];
    if (firstPendingChunk.startPosition > renderedEndPositionRef.current) {
      const canReplayVisibleSuffix =
        renderedEndPositionRef.current >= streamState.startPosition &&
        renderedEndPositionRef.current <= streamState.endPosition;
      if (!canReplayVisibleSuffix) {
        resetTerminalToSnapshot(term, streamState);
        return;
      }
      const replayOffset = renderedEndPositionRef.current - streamState.startPosition;
      const visibleSuffix = streamState.text.slice(replayOffset);
      if (visibleSuffix.length > 0) {
        writeTerminalChunk(term, visibleSuffix);
      }
      renderedEndPositionRef.current = streamState.endPosition;
      renderedTextRef.current = streamState.text;
      if (!followOutputPausedRef.current) {
        scrollToLatest(term);
      }
      return;
    }

    let expectedPosition = renderedEndPositionRef.current;
    let contiguous = true;
    const deltaParts: string[] = [];
    for (const chunk of pendingChunks) {
      if (chunk.endPosition <= expectedPosition) {
        continue;
      }
      if (chunk.startPosition > expectedPosition) {
        contiguous = false;
        break;
      }
      const sliceStart = Math.max(0, expectedPosition - chunk.startPosition);
      deltaParts.push(chunk.data.slice(sliceStart));
      expectedPosition = chunk.endPosition;
    }
    if (!contiguous || expectedPosition < streamState.endPosition) {
      const canReplayVisibleSuffix =
        renderedEndPositionRef.current >= streamState.startPosition &&
        renderedEndPositionRef.current <= streamState.endPosition;
      if (!canReplayVisibleSuffix) {
        resetTerminalToSnapshot(term, streamState);
        return;
      }
      const replayOffset = renderedEndPositionRef.current - streamState.startPosition;
      const visibleSuffix = streamState.text.slice(replayOffset);
      applyQueuedStreamAdvance(term, streamState, visibleSuffix);
      return;
    }
    const delta = deltaParts.join('');
    applyQueuedStreamAdvance(term, streamState, delta);
  }, [applyLocalResize, applyQueuedStreamAdvance, resetTerminalToSnapshot, sessionId, streamState]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const host = hostRef.current;
    const term = new Terminal({
      cursorBlink: false,
      convertEol: false,
      allowProposedApi: true,
      scrollback: normalizedScrollbackLines,
      fontFamily: '"SF Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      fontWeight: 460,
      lineHeight: 1.28,
      letterSpacing: 0.1,
      theme: {
        background: '#081121',
        foreground: '#d9e3f5',
        cursor: '#f5f8ff',
        cursorAccent: '#081121',
        selectionBackground: 'rgba(162, 182, 216, 0.24)',
        black: '#172033',
        red: '#f39a86',
        green: '#69d5a8',
        yellow: '#f0c97f',
        blue: '#90bcff',
        magenta: '#ccb2ff',
        cyan: '#86d7ec',
        white: '#d9e3f5',
        brightBlack: '#77849d',
        brightRed: '#f7ae9f',
        brightGreen: '#84dfb8',
        brightYellow: '#f6d79b',
        brightBlue: '#abcfff',
        brightMagenta: '#dbc5ff',
        brightCyan: '#9ce2f2',
        brightWhite: '#f5f8ff'
      },
      disableStdin: readOnly || !inputEnabled
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT });
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon(openExternalLink));
    term.open(host);
    hardenTerminalTextInput(host);
    applyLocalResize(term, fitAddon.proposeDimensions(), { report: true });
    resetTerminalToSnapshot(term, streamStateRef.current);

    const searchResultsDisposable = searchAddon.onDidChangeResults?.((event) => {
      setSearchResultCount(event?.resultCount ?? 0);
      setSearchResultIndex((event?.resultIndex ?? 1) - 1);
    });

    const onDataDisposable = term.onData((data) => {
      if (readOnlyRef.current || !inputEnabledRef.current) {
        return;
      }
      if (followOutputPausedRef.current) {
        scrollToLatest(term, { force: true });
      }
      onDataRef.current?.(data);
      if (!cursorVisibleRef.current && looksLikeStatefulTerminalUi(renderedTextRef.current)) {
        writeTerminalChunk(term, DECTCEM_HIDE);
      }
    });

    const onScrollDisposable = term.onScroll(() => {
      handleFollowOutputScroll(term);
    });

    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !readOnlyRef.current &&
        inputEnabledRef.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        onDataRef.current?.(MULTILINE_ENTER_SEQUENCE);
        return false;
      }
      if (
        event.type === 'keydown' &&
        ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        armUserScrollIntent();
        if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) {
          pauseFollowForUserScroll();
        }
      }
      return true;
    });

    const viewport = host.querySelector<HTMLElement>('.xterm-viewport');
    const clearUserScrollIntent = () => {
      if (userScrollIntentTimeoutRef.current !== null) {
        window.clearTimeout(userScrollIntentTimeoutRef.current);
        userScrollIntentTimeoutRef.current = null;
      }
      userScrollIntentRef.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      armUserScrollIntent();
      if (event.deltaY < 0) {
        pauseFollowForUserScroll();
      }
    };
    const onPointerDown = () => {
      armUserScrollIntent();
    };
    const onViewportScroll = () => {
      handleFollowOutputScroll(term);
    };
    const onPointerUp = () => {
      window.setTimeout(clearUserScrollIntent, 0);
    };
    viewport?.addEventListener('wheel', onWheel, { passive: true, capture: true });
    viewport?.addEventListener('pointerdown', onPointerDown);
    viewport?.addEventListener('scroll', onViewportScroll);
    viewport?.addEventListener('pointerup', onPointerUp);
    viewport?.addEventListener('pointercancel', onPointerUp);
    viewport?.addEventListener('pointerleave', onPointerUp);

    const resizeToHost = () => {
      applyMeasuredResize(term, fitAddon.proposeDimensions());
    };
    const observer = new ResizeObserver(() => {
      resizeToHost();
    });
    observer.observe(host);

    resizeToHost();
    window.requestAnimationFrame(() => {
      if (terminalRef.current === term) {
        resizeToHost();
      }
    });
    if ('fonts' in document) {
      void (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(() => {
        if (terminalRef.current === term) {
          resizeToHost();
        }
      });
    }

    return () => {
      observer.disconnect();
      viewport?.removeEventListener('wheel', onWheel, true);
      viewport?.removeEventListener('pointerdown', onPointerDown);
      viewport?.removeEventListener('scroll', onViewportScroll);
      viewport?.removeEventListener('pointerup', onPointerUp);
      viewport?.removeEventListener('pointercancel', onPointerUp);
      viewport?.removeEventListener('pointerleave', onPointerUp);
      if (userScrollIntentTimeoutRef.current !== null) {
        window.clearTimeout(userScrollIntentTimeoutRef.current);
        userScrollIntentTimeoutRef.current = null;
      }
      searchResultsDisposable?.dispose?.();
      onDataDisposable.dispose();
      onScrollDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      host.textContent = '';
    };
  }, [
    applyLocalResize,
    applyMeasuredResize,
    armUserScrollIntent,
    handleFollowOutputScroll,
    pauseFollowForUserScroll,
    resetTerminalToSnapshot
  ]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || term.options.scrollback === normalizedScrollbackLines) {
      return;
    }
    term.options.scrollback = normalizedScrollbackLines;
  }, [normalizedScrollbackLines]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [searchOpen]);

  useEffect(() => {
    if (previousSearchToggleRequestRef.current === searchToggleRequestId) {
      return;
    }
    previousSearchToggleRequestRef.current = searchToggleRequestId;
    if (!searchToggleRequestId) {
      return;
    }
    setSearchOpen((current) => !current);
  }, [searchToggleRequestId]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    const normalizedQuery = searchQuery.trim();
    runTerminalSearch(normalizedQuery, 'next', true);
  }, [runTerminalSearch, searchOpen, searchQuery]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || previousRepairRequestRef.current === repairRequestId) {
      return;
    }
    previousRepairRequestRef.current = repairRequestId;
    resetTerminalToSnapshot(term, streamStateRef.current);
  }, [repairRequestId, resetTerminalToSnapshot]);

  useEffect(() => {
    if (!focusRequestId) {
      return;
    }
    terminalRef.current?.focus();
  }, [focusRequestId]);

  const handlePanelFocusCapture = useCallback(() => {
    onFocusChangeRef.current?.(true);
  }, []);

  const handlePanelBlurCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    onFocusChangeRef.current?.(false);
  }, []);

  return (
    <section
      className={searchOpen ? 'terminal-panel terminal-panel-search-open' : 'terminal-panel'}
      onFocusCapture={handlePanelFocusCapture}
      onBlurCapture={handlePanelBlurCapture}
    >
      <div ref={hostRef} className="terminal-host" />
      {searchOpen ? (
        <div className="terminal-search" data-testid="terminal-search">
          <div className="terminal-search-input-wrap">
            <input
              ref={searchInputRef}
              type="search"
              className="terminal-search-input"
              data-testid="terminal-search-input"
              aria-label="Search terminal"
              placeholder="Search terminal"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onBlur={() => {
                searchAddonRef.current?.clearActiveDecoration?.();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeSearch();
                  return;
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  runTerminalSearch(searchQuery, event.shiftKey ? 'previous' : 'next');
                }
              }}
            />
          </div>
          <span className="terminal-search-count" data-testid="terminal-search-count">
            {searchResultLabel}
          </span>
          <button
            type="button"
            className="terminal-search-button"
            data-testid="terminal-search-prev"
            aria-label="Previous match"
            disabled={!searchQuery}
            onClick={() => {
              runTerminalSearch(searchQuery, 'previous');
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 7-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="terminal-search-button"
            data-testid="terminal-search-next"
            aria-label="Next match"
            disabled={!searchQuery}
            onClick={() => {
              runTerminalSearch(searchQuery, 'next');
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m9 7 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="terminal-search-button"
            data-testid="terminal-search-close"
            aria-label="Close search"
            onClick={closeSearch}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}
      {followOutputPaused ? (
        <div className="terminal-controls">
          <button
            type="button"
            className="terminal-follow-button"
            onClick={() => {
              const term = terminalRef.current;
              if (!term) {
                return;
              }
              scrollToLatest(term, { force: true });
            }}
          >
            Jump to latest
          </button>
        </div>
      ) : null}
      {overlayMessage ? <div className="terminal-overlay">{overlayMessage}</div> : null}
    </section>
  );
}
