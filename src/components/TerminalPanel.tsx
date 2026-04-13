import React, { useCallback, useEffect, useRef, useState, type FocusEvent as ReactFocusEvent } from 'react';

import 'xterm/css/xterm.css';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon, type ISearchOptions } from 'xterm-addon-search';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { Terminal } from 'xterm';
import { api } from '../lib/api';
import {
  clearTerminalDebug,
  formatTerminalDebugEvent,
  isTerminalDebugEnabled,
  pushTerminalDebug,
  subscribeTerminalDebug
} from '../lib/terminalDebug';
import {
  createFollowState,
  detachViewport,
  handleTerminalScroll,
  jumpToLatest as jumpFollowStateToLatest,
  pauseFollowByUser,
  shouldAutoFollow,
  shouldPreserveViewport,
  type TerminalFollowState
} from '../lib/terminalFollowState';
import { shouldScheduleTerminalStreamRepair } from '../lib/terminalStreamRepair';
import type { TerminalSessionStreamState } from '../lib/terminalSessionStream';
import { looksLikeStatefulTerminalUi } from '../lib/terminalUiHeuristics';
import { TerminalWriteQueue } from '../lib/terminalWriteQueue';

const INPUT_FLUSH_MS = 8;
const INPUT_CHUNK_SIZE = 4 * 1024;
const OUTPUT_BATCH_BYTES = 16 * 1024;
const OUTPUT_BATCH_BYTES_INTERACTIVE = 8 * 1024;
const OUTPUT_MAX_FLUSH_DELAY_MS = 48;
const STREAM_REPAIR_IDLE_DELAY_MS = 120;
const OUTPUT_QUEUE_WARN_PENDING_BYTES = 128 * 1024;
const OUTPUT_QUEUE_WARN_LATENCY_MS = 96;
const OUTPUT_QUEUE_WARN_COOLDOWN_MS = 2_000;
const VIEWPORT_OFF_BOTTOM_THRESHOLD_PX = 4;
const VIEWPORT_RESUME_NEAR_BOTTOM_MIN_PX = 96;
const VIEWPORT_RESUME_NEAR_BOTTOM_MAX_PX = 240;
const VIEWPORT_OVERLAY_SCROLLBAR_HIT_WIDTH_PX = 24;
const DEFERRED_INITIAL_REPLAY_FALLBACK_MS = 1_400;
const MULTILINE_ENTER_SEQUENCE = '\x1b\r';
const MULTILINE_ENTER_DUPLICATE_SUPPRESSION_MS = 64;
const OPTIMISTIC_SUBMIT_CURSOR_HIDE_MS = 1_200;
const DECTCEM_HIDE = '\x1b[?25l';
const DECTCEM_SHOW = '\x1b[?25h';
const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 500;
const TERMINAL_TEXTAREA_SELECTOR = 'textarea.xterm-helper-textarea, textarea';
const TERMINAL_SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#27415d',
  matchBorder: '#5e83b5',
  matchOverviewRuler: '#4f79ac',
  activeMatchBackground: '#8fb7ff',
  activeMatchBorder: '#d6e6ff',
  activeMatchColorOverviewRuler: '#8fb7ff'
};

interface PendingRepairState {
  preserveViewport: boolean;
  scrollbackOffset: number;
  pausedViewportScrollTop: number | null;
}

interface TerminalPanelProps {
  sessionId?: string | null;
  streamState?: TerminalSessionStreamState | null;
  content?: string;
  contentByteCount?: number;
  contentGeneration?: number;
  contentLimitChars?: number;
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
  onStatefulRedrawRequest?: () => void;
  onFollowOutputPausedChange?: (paused: boolean) => void;
}

// Memoized to avoid unnecessary re-renders (and xterm canvas flicker) when the
// parent re-renders due to unrelated state such as background-thread working-state.
// All callback props (onData, onResize, onFocusChange) must be identity-stable at
// the call site — the component stores them in refs internally but still needs a
// render to sync the refs.
export const TerminalPanel = React.memo(
  TerminalPanelComponent,
  (prevProps, nextProps) => {
    return prevProps.sessionId === nextProps.sessionId &&
      prevProps.streamState === nextProps.streamState &&
      prevProps.content === nextProps.content &&
      prevProps.contentByteCount === nextProps.contentByteCount &&
      prevProps.contentGeneration === nextProps.contentGeneration &&
      prevProps.contentLimitChars === nextProps.contentLimitChars &&
      prevProps.readOnly === nextProps.readOnly &&
      prevProps.inputEnabled === nextProps.inputEnabled &&
      prevProps.cursorVisible === nextProps.cursorVisible &&
      prevProps.overlayMessage === nextProps.overlayMessage &&
      prevProps.preferLiveRedrawOnMount === nextProps.preferLiveRedrawOnMount &&
      prevProps.focusRequestId === nextProps.focusRequestId &&
      prevProps.repairRequestId === nextProps.repairRequestId &&
      prevProps.searchToggleRequestId === nextProps.searchToggleRequestId &&
      prevProps.onData === nextProps.onData &&
      prevProps.onResize === nextProps.onResize &&
      prevProps.onFocusChange === nextProps.onFocusChange &&
      prevProps.onStatefulRedrawRequest === nextProps.onStatefulRedrawRequest &&
      prevProps.onFollowOutputPausedChange === nextProps.onFollowOutputPausedChange;
  }
);

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

function getViewportResumeNearBottomThresholdPx(viewport: HTMLElement | null): number {
  if (!viewport) {
    return VIEWPORT_OFF_BOTTOM_THRESHOLD_PX;
  }
  const dynamicThreshold = Math.round(viewport.clientHeight * 0.75);
  return Math.min(
    VIEWPORT_RESUME_NEAR_BOTTOM_MAX_PX,
    Math.max(VIEWPORT_RESUME_NEAR_BOTTOM_MIN_PX, dynamicThreshold)
  );
}

function TerminalPanelComponent({
  sessionId = null,
  streamState = null,
  content = '',
  contentByteCount,
  contentGeneration,
  contentLimitChars: _contentLimitChars,
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
  onStatefulRedrawRequest,
  onFollowOutputPausedChange
}: TerminalPanelProps) {
  const terminalDebugEnabled = isTerminalDebugEnabled();
  const [fallback, setFallback] = useState(
    () =>
      import.meta.env.MODE === 'test' &&
      !(globalThis as { __ATCONTROLLER_ENABLE_XTERM_TESTS__?: boolean }).__ATCONTROLLER_ENABLE_XTERM_TESTS__
  );
  const [followOutputPaused, setFollowOutputPaused] = useState(false);
  const [terminalDebugLines, setTerminalDebugLines] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResultCount, setSearchResultCount] = useState(0);
  const [searchResultIndex, setSearchResultIndex] = useState(-1);
  const [terminalInstanceVersion, setTerminalInstanceVersion] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchDecorationsEnabledRef = useRef(true);
  const searchOpenRef = useRef(searchOpen);
  const searchQueryRef = useRef(searchQuery);
  const contentRef = useRef(content);
  const renderedContentRef = useRef(content);
  const renderedByteCountRef = useRef(contentByteCount ?? content.length);
  const renderedGenerationRef = useRef(contentGeneration ?? 0);
  const renderedStreamEndPositionRef = useRef(streamState?.endPosition ?? content.length);
  const renderedResetTokenRef = useRef(streamState?.resetToken ?? 0);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onFocusChangeRef = useRef(onFocusChange);
  const onStatefulRedrawRequestRef = useRef(onStatefulRedrawRequest);
  const onFollowOutputPausedChangeRef = useRef(onFollowOutputPausedChange);
  const readOnlyRef = useRef(readOnly);
  const inputEnabledRef = useRef(inputEnabled);
  const cursorVisibleRef = useRef(cursorVisible);
  const previousInputEnabledRef = useRef(inputEnabled);
  const sessionRef = useRef<string | null>(sessionId);
  const followStateRef = useRef(createFollowState());
  const writeQueueRef = useRef(
    new TerminalWriteQueue({
      maxBatchBytes: OUTPUT_BATCH_BYTES,
      maxFlushDelayMs: OUTPUT_MAX_FLUSH_DELAY_MS
    })
  );
  const inputBufferRef = useRef('');
  const inputFlushTimerRef = useRef<number | null>(null);
  const optimisticSubmitCursorTimerRef = useRef<number | null>(null);
  const optimisticSubmitCursorHiddenRef = useRef(false);
  const refreshFrameRef = useRef<number | null>(null);
  const previousFocusRequestRef = useRef(focusRequestId);
  const previousRepairRequestRef = useRef(repairRequestId);
  const previousSearchToggleRequestRef = useRef(searchToggleRequestId);
  const previousFollowOutputPausedRef = useRef(followOutputPaused);
  const statefulSessionRef = useRef(
    Boolean(
      (streamState?.text && looksLikeStatefulTerminalUi(streamState.text)) ||
      (content && looksLikeStatefulTerminalUi(content))
    )
  );
  const lastQueueWarningAtRef = useRef(0);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitWithReflowRef = useRef<(() => void) | null>(null);
  const lastReportedTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const bulkWritingRef = useRef(false);
  const bulkWriteEpochRef = useRef(0);
  const isWritingRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const userResumeFollowRef = useRef(false);
  const userViewportCapturePendingRef = useRef(false);
  const userViewportCaptureResetRafRef = useRef<number | null>(null);
  const viewportPointerDownRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const pausedViewportCaptureRafRef = useRef<number | null>(null);
  const pausedViewportRestoreRafRef = useRef<number | null>(null);
  const pausedViewportScrollTopRef = useRef<number | null>(null);
  const pausedViewportScrollbackOffsetRef = useRef<number | null>(null);
  const scrollPauseCooldownRef = useRef(0);
  const streamRepairTimerRef = useRef<number | null>(null);
  const streamRepairEpochRef = useRef(0);
  const bytesSinceRepairRef = useRef(0);
  const lastStreamRepairAtRef = useRef(0);
  const suppressPlainEnterUntilRef = useRef(0);
  const pendingRepairStateRef = useRef<PendingRepairState | null>(null);
  const deferredInitialReplayTimerRef = useRef<number | null>(null);
  const pendingStatefulResizeDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);

  const logTerminalDebug = useCallback(
    (scope: string, data: Record<string, unknown> = {}, term: Terminal | null = terminalRef.current) => {
      if (!terminalDebugEnabled) {
        return;
      }
      pushTerminalDebug(scope, {
        sessionId: sessionRef.current ?? null,
        followMode: followStateRef.current.mode,
        viewportY: term?.buffer.active.viewportY ?? null,
        baseY: term?.buffer.active.baseY ?? null,
        ...data
      });
    },
    [terminalDebugEnabled]
  );

  const clearOptimisticSubmitCursorHide = useCallback(
    (reason: string, options: { restoreCursor?: boolean } = {}) => {
      if (optimisticSubmitCursorTimerRef.current !== null) {
        window.clearTimeout(optimisticSubmitCursorTimerRef.current);
        optimisticSubmitCursorTimerRef.current = null;
      }
      if (!optimisticSubmitCursorHiddenRef.current) {
        return;
      }
      optimisticSubmitCursorHiddenRef.current = false;
      const term = terminalRef.current;
      if (!term) {
        return;
      }
      const shouldRestoreCursor = Boolean(options.restoreCursor && cursorVisibleRef.current);
      logTerminalDebug('inputSubmit:cursor-hide-cleared', {
        reason,
        restoreCursor: shouldRestoreCursor
      }, term);
      if (shouldRestoreCursor) {
        term.write(DECTCEM_SHOW);
      }
    },
    [logTerminalDebug]
  );

  const armOptimisticSubmitCursorHide = useCallback((term: Terminal) => {
    if (!statefulSessionRef.current || !cursorVisibleRef.current) {
      return;
    }
    if (optimisticSubmitCursorTimerRef.current !== null) {
      window.clearTimeout(optimisticSubmitCursorTimerRef.current);
      optimisticSubmitCursorTimerRef.current = null;
    }
    optimisticSubmitCursorHiddenRef.current = true;
    logTerminalDebug('inputSubmit:cursor-hide-armed', {}, term);
    term.write(DECTCEM_HIDE);
    optimisticSubmitCursorTimerRef.current = window.setTimeout(() => {
      optimisticSubmitCursorTimerRef.current = null;
      if (!optimisticSubmitCursorHiddenRef.current) {
        return;
      }
      optimisticSubmitCursorHiddenRef.current = false;
      if (terminalRef.current !== term || !cursorVisibleRef.current) {
        return;
      }
      logTerminalDebug('inputSubmit:cursor-hide-timeout-restore', {}, term);
      term.write(DECTCEM_SHOW);
    }, OPTIMISTIC_SUBMIT_CURSOR_HIDE_MS);
  }, [logTerminalDebug]);

  interface ResetTerminalContentOptions {
    preserveViewport?: boolean;
    afterWrite?: ((term: Terminal) => void) | null;
  }

  const syncFollowOutputPaused = useCallback((nextPaused: boolean) => {
    setFollowOutputPaused((current) => (current === nextPaused ? current : nextPaused));
  }, []);

  const syncFollowOutputIndicator = useCallback(
    (mode: TerminalFollowState['mode'] = followStateRef.current.mode) => {
      syncFollowOutputPaused(mode === 'pausedByUser' || (mode === 'detached' && statefulSessionRef.current));
    },
    [syncFollowOutputPaused]
  );

  const shouldFreezeStatefulViewport = useCallback(
    (mode: TerminalFollowState['mode'] = followStateRef.current.mode) =>
      statefulSessionRef.current && mode !== 'following',
    []
  );

  const updateStatefulSessionMode = useCallback((candidate: string | null | undefined) => {
    if (!candidate || statefulSessionRef.current) {
      return statefulSessionRef.current;
    }
    if (looksLikeStatefulTerminalUi(candidate)) {
      statefulSessionRef.current = true;
      if (followStateRef.current.mode !== 'following') {
        syncFollowOutputIndicator(followStateRef.current.mode);
      }
    }
    return statefulSessionRef.current;
  }, [syncFollowOutputIndicator]);

  const preserveViewportState = useCallback((term: Terminal, reason: string) => {
    const current = followStateRef.current;
    if (current.mode === 'pausedByUser') {
      logTerminalDebug('follow:preserve-paused', { reason }, term);
      syncFollowOutputIndicator(current.mode);
      return;
    }
    const next = detachViewport({
      ...current,
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY
    });
    followStateRef.current = next;
    logTerminalDebug('follow:preserve-detached', {
      reason,
      viewportY: next.viewportY,
      baseY: next.baseY
    }, term);
    syncFollowOutputIndicator(next.mode);
  }, [logTerminalDebug, syncFollowOutputIndicator]);

  useEffect(() => {
    if (!terminalDebugEnabled) {
      return;
    }
    clearTerminalDebug();
    return subscribeTerminalDebug((events) => {
      setTerminalDebugLines(events.slice(-24).map((event) => formatTerminalDebugEvent(event)));
    });
  }, [terminalDebugEnabled]);

  const clearSearchResults = useCallback(() => {
    searchAddonRef.current?.clearActiveDecoration?.();
    searchAddonRef.current?.clearDecorations?.();
    setSearchResultCount(0);
    setSearchResultIndex(-1);
  }, []);

  const runTerminalSearch = useCallback(
    (query: string, direction: 'next' | 'previous', incremental = false) => {
      if (!query) {
        clearSearchResults();
        return false;
      }

      const searchAddon = searchAddonRef.current;
      if (!searchAddon) {
        return false;
      }

      const runWithOptions = (options: ISearchOptions) =>
        direction === 'previous' ? searchAddon.findPrevious(query, options) : searchAddon.findNext(query, options);

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
    },
    [clearSearchResults]
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    clearSearchResults();
    window.requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
  }, [clearSearchResults]);

  const getViewportElement = useCallback((): HTMLElement | null => {
    const host = hostRef.current;
    if (!host) {
      return null;
    }
    const viewport = host.querySelector('.xterm-viewport');
    return viewport instanceof HTMLElement ? viewport : null;
  }, []);

  const clearScheduledStreamRepair = useCallback(() => {
    if (streamRepairTimerRef.current !== null) {
      window.clearTimeout(streamRepairTimerRef.current);
      streamRepairTimerRef.current = null;
    }
  }, []);

  const clearDeferredInitialReplay = useCallback(() => {
    if (deferredInitialReplayTimerRef.current !== null) {
      window.clearTimeout(deferredInitialReplayTimerRef.current);
      deferredInitialReplayTimerRef.current = null;
    }
  }, []);

  const forceViewportToBottom = useCallback(
    (term: Terminal, reason: string) => {
      const viewport = getViewportElement();
      if (!viewport) {
        return;
      }
      const targetScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(viewport.scrollTop - targetScrollTop) <= 0.5) {
        return;
      }
      logTerminalDebug('viewportScrollTop:force-bottom', {
        reason,
        previousScrollTop: viewport.scrollTop,
        targetScrollTop
      }, term);
      viewport.scrollTop = targetScrollTop;
    },
    [getViewportElement, logTerminalDebug]
  );

  const notifyResizeDimensionsIfChanged = useCallback((cols: number, rows: number) => {
    const previous = lastReportedTerminalSizeRef.current;
    if (previous && previous.cols === cols && previous.rows === rows) {
      return false;
    }
    lastReportedTerminalSizeRef.current = {
      cols,
      rows
    };
    onResizeRef.current?.(cols, rows);
    return true;
  }, []);

  const notifyResizeIfChanged = useCallback((term: Terminal) => {
    return notifyResizeDimensionsIfChanged(term.cols, term.rows);
  }, [notifyResizeDimensionsIfChanged]);

  const applyMeasuredLocalResize = useCallback((term: Terminal, dims: { cols: number; rows: number } | null) => {
    if (!dims || isNaN(dims.cols) || isNaN(dims.rows)) {
      return;
    }
    if (term.cols === dims.cols && term.rows === dims.rows) {
      return;
    }
    term.resize(dims.cols, dims.rows);
  }, []);

  const scrollToBottomSoon = useCallback((term: Terminal) => {
    const autoFollow = shouldAutoFollow(followStateRef.current);
    const withinCooldown = Date.now() < scrollPauseCooldownRef.current;
    logTerminalDebug('scrollToBottomSoon:request', {
      autoFollow,
      withinCooldown,
      rafPending: scrollRafRef.current !== null
    }, term);
    if (!autoFollow) {
      return;
    }
    // Skip if within the cooldown window after user paused scroll.
    // This prevents a race where a write-batch completion fires scrollToBottom
    // before the pause handler has propagated through React state.
    if (withinCooldown) {
      return;
    }
    // Coalesce rapid scroll requests into a single rAF to avoid fighting with
    // user scroll gestures and reduce redundant work during burst output.
    if (scrollRafRef.current !== null) {
      return;
    }
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (terminalRef.current !== term) {
        logTerminalDebug('scrollToBottomSoon:skip-stale', {}, term);
        return;
      }
      if (!shouldAutoFollow(followStateRef.current)) {
        logTerminalDebug('scrollToBottomSoon:skip-paused', {}, term);
        return;
      }
      if (Date.now() < scrollPauseCooldownRef.current) {
        logTerminalDebug('scrollToBottomSoon:skip-cooldown', {}, term);
        return;
      }
      logTerminalDebug('scrollToBottomSoon:call', {}, term);
      term.scrollToBottom();
      forceViewportToBottom(term, 'scrollToBottomSoon');
    });
  }, [forceViewportToBottom, logTerminalDebug]);

  const openExternalLink = useCallback((_: MouseEvent, uri: string) => {
    const target = uri.trim();
    if (!target) {
      return;
    }
    void api.openExternalUrl(target).catch(() => {
      const newWindow = window.open(target, '_blank', 'noopener,noreferrer');
      if (!newWindow) {
        return;
      }
      try {
        newWindow.opener = null;
      } catch {
        // no-op: some runtimes disallow setting opener
      }
    });
  }, []);

  const scheduleTerminalRefresh = useCallback((term: Terminal) => {
    if (refreshFrameRef.current !== null) {
      return;
    }
    refreshFrameRef.current = window.requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      if (terminalRef.current !== term) {
        return;
      }
      term.refresh(0, Math.max(0, term.rows - 1));
    });
  }, []);

  const armUserViewportInteraction = useCallback(() => {
    if (pausedViewportRestoreRafRef.current !== null) {
      window.cancelAnimationFrame(pausedViewportRestoreRafRef.current);
      pausedViewportRestoreRafRef.current = null;
    }
    userViewportCapturePendingRef.current = true;
    if (userViewportCaptureResetRafRef.current !== null) {
      window.cancelAnimationFrame(userViewportCaptureResetRafRef.current);
    }
    userViewportCaptureResetRafRef.current = window.requestAnimationFrame(() => {
      userViewportCaptureResetRafRef.current = null;
      if (!userScrollIntentRef.current) {
        userViewportCapturePendingRef.current = false;
      }
    });
  }, []);

  const clearPausedViewportScrollTop = useCallback(
    (reason: string, term: Terminal | null = terminalRef.current) => {
      if (
        pausedViewportScrollTopRef.current === null &&
        pausedViewportScrollbackOffsetRef.current === null
      ) {
        return;
      }
      logTerminalDebug('viewportScrollTop:clear', {
        reason,
        scrollTop: pausedViewportScrollTopRef.current,
        scrollbackOffset: pausedViewportScrollbackOffsetRef.current
      }, term);
      pausedViewportScrollTopRef.current = null;
      pausedViewportScrollbackOffsetRef.current = null;
    },
    [logTerminalDebug]
  );

  const resumeFollowOutput = useCallback(
    (term: Terminal, reason: string) => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (userViewportCaptureResetRafRef.current !== null) {
        window.cancelAnimationFrame(userViewportCaptureResetRafRef.current);
        userViewportCaptureResetRafRef.current = null;
      }
      if (pausedViewportCaptureRafRef.current !== null) {
        window.cancelAnimationFrame(pausedViewportCaptureRafRef.current);
        pausedViewportCaptureRafRef.current = null;
      }
      if (pausedViewportRestoreRafRef.current !== null) {
        window.cancelAnimationFrame(pausedViewportRestoreRafRef.current);
        pausedViewportRestoreRafRef.current = null;
      }
      userScrollIntentRef.current = false;
      userResumeFollowRef.current = false;
      userViewportCapturePendingRef.current = false;
      viewportPointerDownRef.current = false;
      followStateRef.current = jumpFollowStateToLatest(followStateRef.current, {
        baseY: term.buffer.active.baseY
      });
      logTerminalDebug(reason, {}, term);
      clearPausedViewportScrollTop(reason, term);
      syncFollowOutputIndicator(followStateRef.current.mode);
      scrollPauseCooldownRef.current = 0;
      term.scrollToBottom();
      forceViewportToBottom(term, reason);
      scheduleTerminalRefresh(term);
    },
    [
      clearPausedViewportScrollTop,
      forceViewportToBottom,
      logTerminalDebug,
      scheduleTerminalRefresh,
      syncFollowOutputIndicator
    ]
  );

  const estimateViewportScrollbackOffset = useCallback(
    (term: Terminal, viewport: HTMLElement | null = getViewportElement()): number | null => {
      if (!viewport) {
        return null;
      }
      const baseY = term.buffer.active.baseY;
      const clientHeight = viewport.clientHeight;
      const scrollHeight = viewport.scrollHeight;
      const scrollTop = viewport.scrollTop;
      if (!Number.isFinite(baseY) || baseY <= 0) {
        return 0;
      }
      if (!Number.isFinite(clientHeight) || !Number.isFinite(scrollHeight) || !Number.isFinite(scrollTop)) {
        return null;
      }
      const maxScrollTop = scrollHeight - clientHeight;
      if (maxScrollTop <= 0) {
        return baseY > 0 ? null : 0;
      }
      const distanceFromBottomPx = Math.max(0, maxScrollTop - scrollTop);
      return Math.max(0, Math.min(baseY, Math.round((distanceFromBottomPx / maxScrollTop) * baseY)));
    },
    [getViewportElement]
  );

  const captureScrollbackOffset = useCallback(
    (term: Terminal, reason: string, viewport: HTMLElement | null = getViewportElement()) => {
      const bufferOffset = Math.max(0, term.buffer.active.baseY - term.buffer.active.viewportY);
      const domOffset = estimateViewportScrollbackOffset(term, viewport);
      const scrollbackOffset = domOffset ?? bufferOffset;
      logTerminalDebug('scrollbackOffset:capture', {
        reason,
        bufferOffset,
        domOffset,
        scrollbackOffset,
        source: domOffset === null ? 'buffer' : 'dom'
      }, term);
      return scrollbackOffset;
    },
    [estimateViewportScrollbackOffset, getViewportElement, logTerminalDebug]
  );

  const capturePausedViewportScrollTop = useCallback(
    (
      reason: string,
      term: Terminal | null = terminalRef.current,
      viewport: HTMLElement | null = getViewportElement()
    ) => {
      if (!term) {
        return;
      }
      pausedViewportScrollbackOffsetRef.current = captureScrollbackOffset(term, reason, viewport);
      if (!viewport) {
        return;
      }
      pausedViewportScrollTopRef.current = viewport.scrollTop;
      logTerminalDebug('viewportScrollTop:capture', {
        reason,
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        scrollbackOffset: pausedViewportScrollbackOffsetRef.current
      }, term);
    },
    [captureScrollbackOffset, getViewportElement, logTerminalDebug]
  );

  const getPreservedScrollbackOffset = useCallback(
    (term: Terminal, reason: string, viewport: HTMLElement | null = getViewportElement()) => {
      if (shouldPreserveViewport(followStateRef.current) && pausedViewportScrollbackOffsetRef.current !== null) {
        logTerminalDebug('scrollbackOffset:reuse', {
          reason,
          scrollbackOffset: pausedViewportScrollbackOffsetRef.current
        }, term);
        return pausedViewportScrollbackOffsetRef.current;
      }
      return captureScrollbackOffset(term, reason, viewport);
    },
    [captureScrollbackOffset, getViewportElement, logTerminalDebug]
  );

  const schedulePausedViewportCapture = useCallback(
    (term: Terminal, reason: string) => {
      if (pausedViewportCaptureRafRef.current !== null) {
        return;
      }
      pausedViewportCaptureRafRef.current = window.requestAnimationFrame(() => {
        pausedViewportCaptureRafRef.current = null;
        if (terminalRef.current !== term || !shouldPreserveViewport(followStateRef.current)) {
          return;
        }
        capturePausedViewportScrollTop(reason, term);
      });
    },
    [capturePausedViewportScrollTop]
  );

  const restorePausedViewport = useCallback(
    (term: Terminal, reason: string) => {
      if (terminalRef.current !== term || !shouldPreserveViewport(followStateRef.current)) {
        return false;
      }
      const viewport = getViewportElement();
      const savedScrollTop = pausedViewportScrollTopRef.current;
      if (!viewport || savedScrollTop === null) {
        return false;
      }
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const targetScrollTop = Math.max(0, Math.min(savedScrollTop, maxScrollTop));
      const targetViewportY =
        maxScrollTop <= 0 || term.buffer.active.baseY <= 0
          ? 0
          : Math.max(
              0,
              Math.min(
                term.buffer.active.baseY,
                Math.round((targetScrollTop / maxScrollTop) * term.buffer.active.baseY)
              )
            );
      const currentScrollTop = viewport.scrollTop;
      logTerminalDebug('viewportScrollTop:restore-check', {
        reason,
        currentScrollTop,
        targetScrollTop,
        targetViewportY,
        currentViewportY: term.buffer.active.viewportY
      }, term);
      if (term.buffer.active.viewportY !== targetViewportY) {
        logTerminalDebug('scrollToLine:write-preserve', {
          targetLine: targetViewportY,
          reason
        }, term);
        term.scrollToLine(targetViewportY);
      }
      const updatedScrollTop = viewport.scrollTop;
      if (Math.abs(updatedScrollTop - targetScrollTop) > 0.5) {
        viewport.scrollTop = targetScrollTop;
        logTerminalDebug('viewportScrollTop:restore', {
          reason,
          previousScrollTop: updatedScrollTop,
          targetScrollTop
        }, term);
      }
      scheduleTerminalRefresh(term);
      return true;
    },
    [getViewportElement, logTerminalDebug, scheduleTerminalRefresh]
  );

  const schedulePausedViewportRestore = useCallback(
    (term: Terminal, reason: string) => {
      if (pausedViewportRestoreRafRef.current !== null) {
        return;
      }
      pausedViewportRestoreRafRef.current = window.requestAnimationFrame(() => {
        pausedViewportRestoreRafRef.current = null;
        restorePausedViewport(term, reason);
      });
    },
    [restorePausedViewport]
  );

  const pauseFollowOutput = useCallback(() => {
    const next = pauseFollowByUser(followStateRef.current);
    if (next === followStateRef.current) {
      logTerminalDebug('follow:pause-noop');
      return;
    }
    followStateRef.current = next;
    // Set a short cooldown so in-flight rAF scroll-to-bottom calls are suppressed.
    // This closes the race window between the user's scroll gesture and pending
    // write-batch completions that would snap the viewport back to the bottom.
    scrollPauseCooldownRef.current = Date.now() + 150;
    clearScheduledStreamRepair();
    // Cancel any pending scroll-to-bottom rAF.
    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    logTerminalDebug('follow:pause', {
      cooldownUntil: scrollPauseCooldownRef.current
    });
    capturePausedViewportScrollTop('pause');
    syncFollowOutputIndicator(next.mode);
  }, [capturePausedViewportScrollTop, clearScheduledStreamRepair, logTerminalDebug, syncFollowOutputIndicator]);

  const applyStreamRepair = useCallback(
    (term: Terminal) => {
      if (terminalRef.current !== term) {
        return;
      }
      const preserveViewport = shouldPreserveViewport(followStateRef.current);
      const scrollbackOffset = preserveViewport
        ? getPreservedScrollbackOffset(term, 'stream-repair')
        : 0;
      logTerminalDebug('streamRepair:apply', {
        preserveViewport,
        scrollbackOffset
      }, term);
      lastStreamRepairAtRef.current = Date.now();
      bytesSinceRepairRef.current = 0;
      fitWithReflowRef.current?.();
      if (preserveViewport) {
        const targetLine = Math.max(0, term.buffer.active.baseY - scrollbackOffset);
        logTerminalDebug('scrollToLine:repair', {
          targetLine,
          scrollbackOffset
        }, term);
        term.scrollToLine(targetLine);
        preserveViewportState(term, 'repair-preserve');
        schedulePausedViewportCapture(term, 'repair-preserve');
      }
      scheduleTerminalRefresh(term);
    },
    [
      getPreservedScrollbackOffset,
      logTerminalDebug,
      preserveViewportState,
      schedulePausedViewportCapture,
      scheduleTerminalRefresh
    ]
  );

  const runStreamRepair = useCallback(
    (term: Terminal) => {
      if (terminalRef.current !== term) {
        return;
      }

      const repairEpoch = streamRepairEpochRef.current + 1;
      streamRepairEpochRef.current = repairEpoch;
      logTerminalDebug('streamRepair:run', {
        repairEpoch
      }, term);

      writeQueueRef.current.flushImmediate();
      const statefulVisibleText = renderedContentRef.current || contentRef.current;
      if (sessionId && updateStatefulSessionMode(statefulVisibleText)) {
        lastStreamRepairAtRef.current = Date.now();
        bytesSinceRepairRef.current = 0;
        logTerminalDebug('streamRepair:skip-stateful', {
          repairEpoch,
          renderedLength: renderedContentRef.current.length,
          contentLength: contentRef.current.length
        }, term);
        scheduleTerminalRefresh(term);
        return;
      }
      applyStreamRepair(term);

      void writeQueueRef.current.whenIdle().then(() => {
        if (terminalRef.current !== term) {
          return;
        }
        if (streamRepairEpochRef.current !== repairEpoch) {
          return;
        }
        if (shouldPreserveViewport(followStateRef.current)) {
          logTerminalDebug('streamRepair:skip-second-pass-paused', {
            repairEpoch
          }, term);
          return;
        }
        logTerminalDebug('streamRepair:run-second-pass', {
          repairEpoch
        }, term);
        applyStreamRepair(term);
      });
    },
    [applyStreamRepair, logTerminalDebug, scheduleTerminalRefresh, sessionId, updateStatefulSessionMode]
  );

  const scheduleStreamRepair = useCallback(
    (term: Terminal, delayMs = STREAM_REPAIR_IDLE_DELAY_MS) => {
      if (streamRepairTimerRef.current !== null) {
        logTerminalDebug('streamRepair:schedule-skip-existing', {
          delayMs
        }, term);
        return;
      }
      logTerminalDebug('streamRepair:schedule', {
        delayMs
      }, term);

      streamRepairTimerRef.current = window.setTimeout(() => {
        streamRepairTimerRef.current = null;
        if (terminalRef.current !== term) {
          return;
        }
        if (shouldPreserveViewport(followStateRef.current)) {
          logTerminalDebug('streamRepair:timer-skip-paused', {}, term);
          return;
        }

        const stats = writeQueueRef.current.getStats();
        logTerminalDebug('streamRepair:timer-fired', {
          delayMs,
          pendingBytes: stats.pendingBytes,
          writing: stats.writing,
          bulkWriting: bulkWritingRef.current,
          isWriting: isWritingRef.current
        }, term);
        if (bulkWritingRef.current || isWritingRef.current || stats.writing || stats.pendingBytes > 0) {
          scheduleStreamRepair(term, STREAM_REPAIR_IDLE_DELAY_MS);
          return;
        }

        runStreamRepair(term);
      }, delayMs);
    },
    [logTerminalDebug, runStreamRepair]
  );

  const maybeLogQueueHealth = useCallback(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const stats = writeQueueRef.current.getStats();
    if (
      stats.pendingBytes < OUTPUT_QUEUE_WARN_PENDING_BYTES &&
      stats.lastQueueLatencyMs < OUTPUT_QUEUE_WARN_LATENCY_MS
    ) {
      return;
    }
    const nowMs = Date.now();
    if (nowMs - lastQueueWarningAtRef.current < OUTPUT_QUEUE_WARN_COOLDOWN_MS) {
      return;
    }
    lastQueueWarningAtRef.current = nowMs;
    console.debug('[terminal-write-queue] burst pressure', {
      pendingBytes: stats.pendingBytes,
      pendingChunks: stats.pendingChunks,
      highWaterBytes: stats.highWaterBytes,
      highWaterChunks: stats.highWaterChunks,
      lastQueueLatencyMs: stats.lastQueueLatencyMs,
      maxQueueLatencyMs: stats.maxQueueLatencyMs,
      maxFlushDelayMs: stats.maxFlushDelayMs
    });
  }, []);

  const flushOutgoingInput = useCallback(() => {
    const payload = inputBufferRef.current;
    if (!payload) {
      return;
    }
    inputBufferRef.current = '';
    onDataRef.current?.(payload);
  }, []);

  const scheduleOutgoingInputFlush = useCallback(() => {
    if (inputFlushTimerRef.current !== null) {
      return;
    }
    inputFlushTimerRef.current = window.setTimeout(() => {
      inputFlushTimerRef.current = null;
      flushOutgoingInput();
    }, INPUT_FLUSH_MS);
  }, [flushOutgoingInput]);

  const queueWrite = useCallback((data: string) => {
    if (data.length === 0) {
      return;
    }
    clearOptimisticSubmitCursorHide('output-arrived');
    clearDeferredInitialReplay();
    writeQueueRef.current.enqueue(data);
  }, [clearDeferredInitialReplay, clearOptimisticSubmitCursorHide]);

  const clearPendingWrites = useCallback(() => {
    writeQueueRef.current.clear();
  }, []);

  const resetTerminalContent = useCallback(
    (nextContent: string, options: ResetTerminalContentOptions = {}) => {
      const term = terminalRef.current;
      if (!term) {
        return;
      }
      const preserveViewport = Boolean(options.preserveViewport);
      const scrollbackOffset = preserveViewport
        ? getPreservedScrollbackOffset(term, 'reset')
        : 0;
      logTerminalDebug('reset:start', {
        nextContentLength: nextContent.length,
        preserveViewport,
        scrollbackOffset
      }, term);

      const bulkWriteEpoch = bulkWriteEpochRef.current + 1;
      bulkWriteEpochRef.current = bulkWriteEpoch;
      bulkWritingRef.current = true;
      clearOptimisticSubmitCursorHide('reset');
      clearPendingWrites();
      term.reset();
      if (!cursorVisibleRef.current) {
        term.write(DECTCEM_HIDE);
      }
      if (nextContent.length > 0) {
        queueWrite(nextContent);
        writeQueueRef.current.flushImmediate();
      }

      void writeQueueRef.current.whenIdle().then(() => {
        if (terminalRef.current !== term) {
          return;
        }
        if (bulkWriteEpochRef.current !== bulkWriteEpoch) {
          return;
        }
        bulkWritingRef.current = false;
        bytesSinceRepairRef.current = 0;
        clearScheduledStreamRepair();
        if (preserveViewport) {
          const targetLine = Math.max(0, term.buffer.active.baseY - scrollbackOffset);
          logTerminalDebug('scrollToLine:reset', {
            targetLine,
            scrollbackOffset,
            bulkWriteEpoch
          }, term);
          term.scrollToLine(targetLine);
          preserveViewportState(term, `reset-preserve:${bulkWriteEpoch}`);
          schedulePausedViewportCapture(term, 'reset-preserve');
        } else {
          followStateRef.current = createFollowState();
          logTerminalDebug('follow:reset-following', {
            bulkWriteEpoch
          }, term);
          clearPausedViewportScrollTop('reset-following', term);
          syncFollowOutputIndicator(followStateRef.current.mode);
          scrollToBottomSoon(term);
        }
        logTerminalDebug('reset:done', {
          nextContentLength: nextContent.length,
          bulkWriteEpoch,
          preserveViewport
        }, term);
        options.afterWrite?.(term);
        scheduleTerminalRefresh(term);
      });
    },
    [
      clearOptimisticSubmitCursorHide,
      getPreservedScrollbackOffset,
      clearPendingWrites,
      clearPausedViewportScrollTop,
      clearScheduledStreamRepair,
      logTerminalDebug,
      preserveViewportState,
      queueWrite,
      schedulePausedViewportCapture,
      scheduleTerminalRefresh,
      scrollToBottomSoon,
      syncFollowOutputIndicator
    ]
  );

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
    onStatefulRedrawRequestRef.current = onStatefulRedrawRequest;
  }, [onStatefulRedrawRequest]);

  useEffect(() => {
    onFollowOutputPausedChangeRef.current = onFollowOutputPausedChange;
  }, [onFollowOutputPausedChange]);

  useEffect(() => {
    onFollowOutputPausedChangeRef.current?.(followOutputPaused);
  }, [followOutputPaused]);

  useEffect(() => {
    const wasPaused = previousFollowOutputPausedRef.current;
    previousFollowOutputPausedRef.current = followOutputPaused;
    if (!wasPaused || followOutputPaused) {
      return;
    }
    if (!streamState || !terminalRef.current) {
      return;
    }
    if (sessionRef.current !== streamState.sessionId) {
      return;
    }
    if (!looksLikeStatefulTerminalUi(streamState.text)) {
      return;
    }
    const isStale =
      renderedResetTokenRef.current !== streamState.resetToken ||
      renderedStreamEndPositionRef.current !== streamState.endPosition ||
      renderedContentRef.current !== streamState.text;
    if (!isStale) {
      return;
    }
    const term = terminalRef.current;
    logTerminalDebug('stateful:resume-sync-latest', {
      renderedEndPosition: renderedStreamEndPositionRef.current,
      nextEndPosition: streamState.endPosition,
      renderedLength: renderedContentRef.current.length,
      nextLength: streamState.text.length
    }, term);
    renderedStreamEndPositionRef.current = streamState.endPosition;
    renderedContentRef.current = streamState.text;
    renderedByteCountRef.current = streamState.text.length;
    renderedGenerationRef.current = streamState.resetToken;
    renderedResetTokenRef.current = streamState.resetToken;
    resetTerminalContent(streamState.text);
  }, [followOutputPaused, logTerminalDebug, resetTerminalContent, streamState]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (!streamState) {
      return;
    }
    contentRef.current = streamState.text;
  }, [streamState]);

  useEffect(() => {
    if (fallback) {
      return;
    }

    const host = hostRef.current;
    if (!host) {
      return;
    }

    try {
      const pendingRepairState = pendingRepairStateRef.current;
      const initialContent = contentRef.current;
      const initialLooksStateful = updateStatefulSessionMode(initialContent);
      const deferInitialReplay =
        preferLiveRedrawOnMount &&
        initialContent.length > 0 &&
        initialLooksStateful;
      logTerminalDebug('panel:create-terminal', {
        pendingRepairPreserveViewport: pendingRepairState?.preserveViewport ?? null,
        pendingRepairOffset: pendingRepairState?.scrollbackOffset ?? null,
        initialContentLength: initialContent.length,
        deferInitialReplay
      });
      const term = new Terminal({
        cursorBlink: false,
        convertEol: false,
        allowProposedApi: true,
        scrollback: 10_000,
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
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon(openExternalLink));
      term.open(host);
      hardenTerminalTextInput(host);
      const inputObserver = new MutationObserver(() => {
        hardenTerminalTextInput(host);
      });
      inputObserver.observe(host, { childList: true, subtree: true });
      logTerminalDebug('panel:opened', {}, term);
      if (!cursorVisibleRef.current) {
        term.write(DECTCEM_HIDE);
      }
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === 'keydown' &&
          event.key === 'Enter' &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          if (!readOnlyRef.current && inputEnabledRef.current) {
            if (!shouldAutoFollow(followStateRef.current)) {
              resumeFollowOutput(term, 'follow:input-resume');
            }
            event.preventDefault();
            event.stopPropagation();
            suppressPlainEnterUntilRef.current = Date.now() + MULTILINE_ENTER_DUPLICATE_SUPPRESSION_MS;
            inputBufferRef.current += MULTILINE_ENTER_SEQUENCE;
            scheduleOutgoingInputFlush();
          }
          return false;
        }
        if (event.type === 'keydown' && event.key === 'PageUp') {
          armUserViewportInteraction();
          pauseFollowOutput();
        }
        return true;
      });
      terminalRef.current = term;
      writeQueueRef.current.setSink({
        write: (chunk, done) => {
          const autoFollow = shouldAutoFollow(followStateRef.current);
          if (!autoFollow && !bulkWritingRef.current) {
            let promotedPendingPausedCapture = false;
            if (pausedViewportCaptureRafRef.current !== null) {
              window.cancelAnimationFrame(pausedViewportCaptureRafRef.current);
              pausedViewportCaptureRafRef.current = null;
              promotedPendingPausedCapture = true;
            }
            if (pausedViewportRestoreRafRef.current === null) {
              capturePausedViewportScrollTop(
                promotedPendingPausedCapture ? 'write-before-promote-pending-capture' : 'write-before',
                term
              );
            }
          }
          isWritingRef.current = true;
          logTerminalDebug('write:start', {
            chunkLength: chunk.length,
            bulkWriting: bulkWritingRef.current,
            autoFollow
          }, term);
          term.write(chunk, () => {
            isWritingRef.current = false;
            logTerminalDebug('write:done', {
              chunkLength: chunk.length,
              bulkWriting: bulkWritingRef.current,
              autoFollow: shouldAutoFollow(followStateRef.current)
            }, term);
            if (terminalRef.current === term && !bulkWritingRef.current) {
              if (shouldAutoFollow(followStateRef.current)) {
                scrollToBottomSoon(term);
              } else {
                schedulePausedViewportRestore(term, 'write');
              }
            }
            scheduleTerminalRefresh(term);
            bytesSinceRepairRef.current += chunk.length;
            const queueStats = writeQueueRef.current.getStats();
            const statefulVisibleText = renderedContentRef.current || contentRef.current;
            if (
              !looksLikeStatefulTerminalUi(statefulVisibleText) &&
              shouldScheduleTerminalStreamRepair({
                autoFollow: shouldAutoFollow(followStateRef.current),
                bytesSinceLastRepair: bytesSinceRepairRef.current,
                lastQueueLatencyMs: queueStats.lastQueueLatencyMs,
                lastRepairAtMs: lastStreamRepairAtRef.current,
                nowMs: Date.now()
              })
            ) {
              scheduleStreamRepair(term);
            }
            maybeLogQueueHealth();
            done();
          });
        }
      });

      // Bypass fitAddon.fit() because it calls _renderService.clear() before
      // resize, which empties every DOM row element synchronously.  The actual
      // repaint is deferred to a rAF via xterm's RenderDebouncer, so the
      // browser paints a blank terminal for one frame.  Using
      // proposeDimensions() + term.resize() directly skips the clear — old
      // content stays visible until xterm's deferred render replaces it.
      const fitAndNotify = () => {
        logTerminalDebug('fit:fitAndNotify:start', {}, term);
        const dims = fitAddon.proposeDimensions();
        if (dims && !isNaN(dims.cols) && !isNaN(dims.rows) &&
            (term.cols !== dims.cols || term.rows !== dims.rows)) {
          term.resize(dims.cols, dims.rows);
        }
        notifyResizeIfChanged(term);
        if (shouldAutoFollow(followStateRef.current)) {
          scrollToBottomSoon(term);
        }
        scheduleTerminalRefresh(term);
        logTerminalDebug('fit:fitAndNotify:end', {
          cols: term.cols,
          rows: term.rows
        }, term);
      };

      const fitPreservingViewport = () => {
        const preserveViewport = shouldPreserveViewport(followStateRef.current);
        const scrollbackOffset = preserveViewport
          ? getPreservedScrollbackOffset(term, 'fit-preserve')
          : 0;
        logTerminalDebug('fit:preserve-start', {
          preserveViewport,
          scrollbackOffset
        }, term);

        fitAndNotify();

        if (preserveViewport) {
          const targetLine = Math.max(0, term.buffer.active.baseY - scrollbackOffset);
          logTerminalDebug('scrollToLine:fit-preserve', {
            targetLine,
            scrollbackOffset
          }, term);
          term.scrollToLine(targetLine);
          preserveViewportState(term, 'fit-preserve');
          schedulePausedViewportCapture(term, 'fit-preserve');
          scheduleTerminalRefresh(term);
          return;
        }

        // Keep follow-mode resizes at the live bottom synchronously so xterm
        // does not paint a transient top-of-buffer frame before the scheduled
        // auto-follow scroll runs on the next animation frame.
        term.scrollToBottom();
        forceViewportToBottom(term, 'fit-following');
        followStateRef.current = {
          mode: 'following',
          viewportY: term.buffer.active.viewportY,
          baseY: term.buffer.active.baseY
        };
        logTerminalDebug('follow:fit-following', {}, term);
        clearPausedViewportScrollTop('fit-following', term);
        scheduleTerminalRefresh(term);
        syncFollowOutputIndicator(followStateRef.current.mode);
      };

      const shouldUseSyntheticReflow = () =>
        !sessionRef.current ||
        (
          renderedContentRef.current.length === 0 &&
          renderedStreamEndPositionRef.current === 0 &&
          contentRef.current.length === 0
        );

      // fitAddon.fit() short-circuits when the proposed cols/rows match the
      // current grid — it skips term.resize(), so xterm never re-measures
      // character metrics. term.resize(same, same) also short-circuits.
      //
      // On a blank terminal we can safely force a one-column reflow nudge to
      // refresh xterm's internal measurements after fonts/container dimensions
      // settle. Once a live Claude session has already painted content,
      // however, synthetic local-only resizes can desynchronize a stateful TUI
      // from the PTY and smear/redraw the screen. In that case we only do an
      // exact fit and wait for real PTY-driven output to repaint.
      const fitWithReflow = () => {
        const cols = term.cols;
        const rows = term.rows;
        const useSyntheticReflow = shouldUseSyntheticReflow();
        logTerminalDebug('fit:reflow-start', {
          cols,
          rows,
          useSyntheticReflow
        }, term);
        if (useSyntheticReflow && cols > 1) {
          term.resize(cols + 1, rows);
          term.resize(cols, rows);
        }
        fitAndNotify();
        logTerminalDebug('fit:reflow-end', {
          cols: term.cols,
          rows: term.rows,
          useSyntheticReflow
        }, term);
      };
      fitWithReflowRef.current = fitWithReflow;

      const runDeferredFitWithReflow = (reason: string) => {
        let promotedPendingPausedCapture = false;
        const preserveViewport = shouldPreserveViewport(followStateRef.current);
        if (preserveViewport && pausedViewportCaptureRafRef.current !== null) {
          window.cancelAnimationFrame(pausedViewportCaptureRafRef.current);
          pausedViewportCaptureRafRef.current = null;
          promotedPendingPausedCapture = true;
        }
        if (preserveViewport && (promotedPendingPausedCapture || pausedViewportScrollTopRef.current === null)) {
          capturePausedViewportScrollTop(
            promotedPendingPausedCapture ? `${reason}-promote-pending-capture` : `${reason}-before`,
            term
          );
        }
        const scrollbackOffset = preserveViewport
          ? getPreservedScrollbackOffset(term, reason)
          : 0;
        const pausedViewportScrollTop = preserveViewport ? pausedViewportScrollTopRef.current : null;
        logTerminalDebug('fit:deferred-reflow-start', {
          reason,
          preserveViewport,
          scrollbackOffset,
          pausedViewportScrollTop
        }, term);

        fitWithReflow();

        if (!preserveViewport) {
          return;
        }
        pausedViewportScrollTopRef.current = pausedViewportScrollTop;
        const targetLine = Math.max(0, term.buffer.active.baseY - scrollbackOffset);
        logTerminalDebug('scrollToLine:deferred-fit-preserve', {
          reason,
          targetLine,
          scrollbackOffset,
          pausedViewportScrollTop
        }, term);
        term.scrollToLine(targetLine);
        preserveViewportState(term, `deferred-fit-preserve:${reason}`);
        if (pausedViewportScrollTop === null) {
          schedulePausedViewportCapture(term, reason);
        } else if (!restorePausedViewport(term, reason)) {
          schedulePausedViewportRestore(term, reason);
        }
        scheduleTerminalRefresh(term);
      };

      const finalizeTerminalReplay = () => {
        if (terminalRef.current !== term) {
          return;
        }
        logTerminalDebug('replay:finalize-start', {
          initialContentLength: initialContent.length,
          pendingRepairPreserveViewport: pendingRepairState?.preserveViewport ?? null,
          pendingRepairOffset: pendingRepairState?.scrollbackOffset ?? null
        }, term);

        renderedContentRef.current = contentRef.current;
        renderedByteCountRef.current = contentByteCount ?? contentRef.current.length;
        renderedGenerationRef.current = contentGeneration ?? 0;
        renderedStreamEndPositionRef.current = streamState?.endPosition ?? contentRef.current.length;
        renderedResetTokenRef.current = streamState?.resetToken ?? 0;
        clearScheduledStreamRepair();
        bytesSinceRepairRef.current = 0;
        lastStreamRepairAtRef.current = Date.now();

        fitWithReflow();

        if (pendingRepairState?.preserveViewport) {
          pausedViewportScrollTopRef.current = pendingRepairState.pausedViewportScrollTop;
          // Preserve the user's relative distance from the bottom of the scrollback.
          // This is only approximate if the replayed terminal wraps differently after reflow.
          const targetLine = Math.max(0, term.buffer.active.baseY - pendingRepairState.scrollbackOffset);
          logTerminalDebug('scrollToLine:replay-preserve', {
            targetLine,
            scrollbackOffset: pendingRepairState.scrollbackOffset,
            pausedViewportScrollTop: pendingRepairState.pausedViewportScrollTop
          }, term);
          term.scrollToLine(targetLine);
          preserveViewportState(term, 'replay-preserve');
          schedulePausedViewportCapture(term, 'replay-preserve');
        } else {
          followStateRef.current = createFollowState();
          logTerminalDebug('follow:replay-following', {}, term);
          clearPausedViewportScrollTop('replay-following', term);
          syncFollowOutputIndicator(followStateRef.current.mode);
          scrollToBottomSoon(term);
        }

        pendingRepairStateRef.current = null;
        scheduleTerminalRefresh(term);
        logTerminalDebug('replay:finalize-end', {}, term);
        if (searchOpenRef.current && searchQueryRef.current) {
          window.requestAnimationFrame(() => {
            if (terminalRef.current !== term) {
              return;
            }
            runTerminalSearch(searchQueryRef.current, 'next', true);
          });
        }
      };

      // Synchronous best-effort fit (renderer may not have dims yet — that's OK).
      fitAndNotify();
      // Live stateful reattach prefers one authoritative redraw path over a burst
      // of mount-time fit/reflow passes that can provoke multiple Claude repaints.
      if (!deferInitialReplay) {
        // Deferred fits use fitWithReflow to force correct metrics.
        window.requestAnimationFrame(() => {
          if (terminalRef.current !== term) {
            return;
          }
          runDeferredFitWithReflow('mount-raf');
        });
        if ('fonts' in document) {
          void (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(() => {
            if (terminalRef.current !== term) {
              return;
            }
            runDeferredFitWithReflow('mount-fonts-ready');
          });
          // Explicitly wait for SF Mono so xterm's char-measure element gets correct metrics.
          // fonts.ready can resolve before the specific font is measurable on cold start.
          void (document as Document & { fonts?: { load: (font: string) => Promise<unknown> } }).fonts
            ?.load('13px "SF Mono"')
            .catch(() => {})
            .then(() => {
              if (terminalRef.current !== term) {
                return;
              }
              runDeferredFitWithReflow('mount-fonts-load');
            });
        }
        window.setTimeout(() => {
          if (terminalRef.current !== term) {
            return;
          }
          runDeferredFitWithReflow('mount-timeout-100');
        }, 100);
        // Second deferred fit for slow Tauri window-restore on first launch.
        window.setTimeout(() => {
          if (terminalRef.current !== term) {
            return;
          }
          runDeferredFitWithReflow('mount-timeout-500');
        }, 500);
      }

      if (initialContent.length > 0 && !deferInitialReplay) {
        queueWrite(initialContent);
        writeQueueRef.current.flushImmediate();
      } else if (initialContent.length > 0 && deferInitialReplay) {
        deferredInitialReplayTimerRef.current = window.setTimeout(() => {
          deferredInitialReplayTimerRef.current = null;
          if (terminalRef.current !== term) {
            return;
          }
          logTerminalDebug('replay:deferred-fallback', {
            initialContentLength: initialContent.length
          }, term);
          resetTerminalContent(initialContent, {
            preserveViewport: shouldPreserveViewport(followStateRef.current)
          });
          scheduleTerminalRefresh(term);
        }, DEFERRED_INITIAL_REPLAY_FALLBACK_MS);
      }
      renderedContentRef.current = initialContent;
      renderedByteCountRef.current = contentByteCount ?? initialContent.length;
      renderedGenerationRef.current = contentGeneration ?? 0;
      renderedStreamEndPositionRef.current = streamState?.endPosition ?? initialContent.length;
      renderedResetTokenRef.current = streamState?.resetToken ?? 0;
      if (!deferInitialReplay) {
        void writeQueueRef.current.whenIdle().then(() => {
          finalizeTerminalReplay();
        });
      }

      const onDataDisposable = term.onData((data) => {
        if (readOnlyRef.current || !inputEnabledRef.current) {
          return;
        }
        if (!shouldAutoFollow(followStateRef.current)) {
          resumeFollowOutput(term, 'follow:input-resume');
        }

        if ((data === '\r' || data === '\n') && Date.now() < suppressPlainEnterUntilRef.current) {
          suppressPlainEnterUntilRef.current = 0;
          return;
        }
        if (Date.now() >= suppressPlainEnterUntilRef.current) {
          suppressPlainEnterUntilRef.current = 0;
        }

        inputBufferRef.current += data;
        if (
          data === '\r' ||
          data === '\x03' ||
          inputBufferRef.current.length >= INPUT_CHUNK_SIZE
        ) {
          if (data === '\r') {
            armOptimisticSubmitCursorHide(term);
          }
          if (inputFlushTimerRef.current !== null) {
            window.clearTimeout(inputFlushTimerRef.current);
            inputFlushTimerRef.current = null;
          }
          flushOutgoingInput();
        } else {
          scheduleOutgoingInputFlush();
        }
      });

      const onScrollDisposable = term.onScroll((viewportY) => {
        const baseY = term.buffer.active.baseY;
        logTerminalDebug('xterm:onScroll', {
          eventViewportY: viewportY,
          bulkWriting: bulkWritingRef.current,
          userScrollIntent: userScrollIntentRef.current,
          userResumeFollow: userResumeFollowRef.current
        }, term);
        if (bulkWritingRef.current) {
          return;
        }
        const prev = followStateRef.current;
        const next = handleTerminalScroll(prev, { viewportY, baseY });
        let resolved = next;

        if (userScrollIntentRef.current) {
          if (viewportY < baseY) {
            pauseFollowOutput();
            userResumeFollowRef.current = false;
            logTerminalDebug('xterm:onScroll-user-pause', {}, term);
            return;
          }
          if (resolved.mode !== 'following' && viewportY >= baseY) {
            resumeFollowOutput(term, 'follow:user-resume-bottom');
            return;
          }
        }

        if (userResumeFollowRef.current) {
          if (resolved.mode !== 'following' && viewportY >= baseY) {
            resumeFollowOutput(term, 'follow:wheel-resume-bottom');
            return;
          }
          userResumeFollowRef.current = false;
        }
        if (resolved.mode === 'detached' && viewportY >= baseY) {
          resolved = jumpFollowStateToLatest(resolved, { baseY });
          clearPausedViewportScrollTop('detached-resume-bottom', term);
        }
        followStateRef.current = resolved;
        logTerminalDebug('follow:onScroll-update', {
          resolvedMode: resolved.mode
        }, term);
        syncFollowOutputIndicator(resolved.mode);
      });

      const onWheel = (event: WheelEvent) => {
        armUserViewportInteraction();
        logTerminalDebug('wheel', {
          deltaY: event.deltaY
        }, term);
        if (event.deltaY < 0) {
          userResumeFollowRef.current = false;
          pauseFollowOutput();
          schedulePausedViewportCapture(term, 'wheel-post-scroll');
          return;
        }
        if (event.deltaY > 0 && followStateRef.current.mode === 'pausedByUser') {
          userResumeFollowRef.current = true;
          logTerminalDebug('follow:wheel-resume-armed', {}, term);
        }
      };
      host.addEventListener('wheel', onWheel, { passive: true, capture: true });

      const viewport = host.querySelector('.xterm-viewport') as HTMLElement | null;
      const onViewportScroll = () => {
        const estimatedScrollbackOffset = estimateViewportScrollbackOffset(term, viewport);
        const distanceFromBottomPx = viewport
          ? Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)
          : null;
        const nearBottomResumeThresholdPx = getViewportResumeNearBottomThresholdPx(viewport);
        const previousPausedViewportScrollTop = pausedViewportScrollTopRef.current;
        const movingTowardBottom =
          viewport && previousPausedViewportScrollTop !== null
            ? viewport.scrollTop > previousPausedViewportScrollTop + 0.5
            : userResumeFollowRef.current;
        const userInteracting =
          userScrollIntentRef.current ||
          userViewportCapturePendingRef.current ||
          viewportPointerDownRef.current;
        logTerminalDebug('viewport:scroll', {
          scrollTop: viewport?.scrollTop ?? null,
          scrollHeight: viewport?.scrollHeight ?? null,
          clientHeight: viewport?.clientHeight ?? null,
          distanceFromBottomPx,
          estimatedScrollbackOffset,
          userInteracting,
          movingTowardBottom,
          nearBottomResumeThresholdPx,
          pausedViewportScrollTop: pausedViewportScrollTopRef.current
        }, term);
        if (
          viewport &&
          followStateRef.current.mode === 'pausedByUser' &&
          userInteracting &&
          !bulkWritingRef.current &&
          !isWritingRef.current
        ) {
          capturePausedViewportScrollTop('viewport-scroll-user', term, viewport);
          if (!userScrollIntentRef.current) {
            userViewportCapturePendingRef.current = false;
          }
        }
        if (
          viewport &&
          distanceFromBottomPx !== null &&
          distanceFromBottomPx <= nearBottomResumeThresholdPx &&
          (
            (shouldFreezeStatefulViewport(followStateRef.current.mode) && movingTowardBottom) ||
            (
              followStateRef.current.mode === 'pausedByUser' &&
              (userResumeFollowRef.current || (userInteracting && movingTowardBottom))
            )
          )
        ) {
          userResumeFollowRef.current = false;
          resumeFollowOutput(term, 'viewport-scroll-user-resume-near-bottom');
          return;
        }
        if (
          viewport &&
          distanceFromBottomPx !== null &&
          distanceFromBottomPx <= nearBottomResumeThresholdPx &&
          followStateRef.current.mode === 'detached' &&
          movingTowardBottom
        ) {
          resumeFollowOutput(term, 'viewport-scroll-detached-resume');
          return;
        }
        if (
          viewport &&
          distanceFromBottomPx !== null &&
          distanceFromBottomPx > VIEWPORT_OFF_BOTTOM_THRESHOLD_PX &&
          !bulkWritingRef.current &&
          shouldAutoFollow(followStateRef.current)
        ) {
          if (userScrollIntentRef.current) {
            logTerminalDebug('follow:viewport-scroll-pause', {
              distanceFromBottomPx
            }, term);
            pauseFollowOutput();
            userViewportCapturePendingRef.current = false;
            userResumeFollowRef.current = false;
            return;
          }
          capturePausedViewportScrollTop('viewport-scroll-detached', term, viewport);
          preserveViewportState(term, 'viewport-scroll-detached');
          userViewportCapturePendingRef.current = false;
          userResumeFollowRef.current = false;
          return;
        }
        if (
          viewport &&
          distanceFromBottomPx !== null &&
          distanceFromBottomPx > VIEWPORT_OFF_BOTTOM_THRESHOLD_PX &&
          !bulkWritingRef.current &&
          followStateRef.current.mode === 'detached'
        ) {
          capturePausedViewportScrollTop('viewport-scroll-detached-update', term, viewport);
        }
      };
      const onViewportPointerDown = (e: PointerEvent) => {
        // Only set scroll intent when the click lands in the native scrollbar area.
        // el.clientWidth excludes the permanent scrollbar gutter; clicks beyond it are on the track.
        // In macOS overlay-scrollbar mode there is no gutter, so also treat a click near the
        // right edge as a likely thumb drag. That keeps paused viewport snapshots in sync when
        // the user repositions the viewport with the native scrollbar instead of the wheel.
        const el = e.currentTarget as HTMLElement;
        viewportPointerDownRef.current = true;
        const rect = el.getBoundingClientRect();
        const hasVisibleScrollbar = el.offsetWidth > el.clientWidth;
        const distanceFromRightPx = rect.right - e.clientX;
        const isOverlayScrollbarHit =
          !hasVisibleScrollbar &&
          distanceFromRightPx >= 0 &&
          distanceFromRightPx <= VIEWPORT_OVERLAY_SCROLLBAR_HIT_WIDTH_PX;
        logTerminalDebug('viewport:pointerdown', {
          clientX: e.clientX,
          distanceFromRightPx,
          hasVisibleScrollbar,
          isOverlayScrollbarHit,
          clientWidth: el.clientWidth,
          offsetWidth: el.offsetWidth
        }, term);
        if (
          (hasVisibleScrollbar && e.clientX > rect.left + el.clientWidth) ||
          isOverlayScrollbarHit
        ) {
          armUserViewportInteraction();
          userScrollIntentRef.current = true;
          logTerminalDebug('follow:scroll-intent-armed', {}, term);
        }
      };
      const clearViewportScrollIntent = () => {
        if (viewport && followStateRef.current.mode === 'pausedByUser' && userScrollIntentRef.current) {
          capturePausedViewportScrollTop('viewport-pointerup', term, viewport);
        }
        viewportPointerDownRef.current = false;
        userScrollIntentRef.current = false;
        userViewportCapturePendingRef.current = false;
        userResumeFollowRef.current = false;
        logTerminalDebug('follow:scroll-intent-cleared', {}, term);
      };
      if (viewport) {
        viewport.addEventListener('scroll', onViewportScroll);
        viewport.addEventListener('pointerdown', onViewportPointerDown);
        viewport.addEventListener('pointerup', clearViewportScrollIntent);
        viewport.addEventListener('pointercancel', clearViewportScrollIntent);
        viewport.addEventListener('pointerleave', clearViewportScrollIntent);
      }

      const searchResultsDisposable = searchAddon.onDidChangeResults(({ resultCount, resultIndex }) => {
        setSearchResultCount(resultCount);
        setSearchResultIndex(resultCount > 0 ? resultIndex : -1);
      });

      // Call fitPreservingViewport synchronously inside ResizeObserver so xterm
      // adjusts before the browser paints this frame.  Deferring via rAF caused a
      // one-frame gap where the container had already resized but xterm still
      // showed the old grid dimensions (visible as a flicker/jump).
      // ResizeObserver already coalesces observations per frame, so external
      // coalescing is unnecessary.  fitAddon.fit() only reads the host's
      // dimensions — it does not mutate them — so there is no re-entry risk.
      const observer = new ResizeObserver(() => {
        const currentStreamState = streamState;
        const shouldForceStatefulResizeResync =
          currentStreamState !== null &&
          sessionRef.current === currentStreamState.sessionId &&
          statefulSessionRef.current &&
          shouldAutoFollow(followStateRef.current);
        const measuredDims = fitAddon.proposeDimensions();
        logTerminalDebug('host:resize-observer', {
          shouldForceStatefulResizeResync,
          measuredCols: measuredDims?.cols ?? null,
          measuredRows: measuredDims?.rows ?? null
        }, term);
        if (shouldForceStatefulResizeResync) {
          clearPendingWrites();
          clearScheduledStreamRepair();
          if (measuredDims && !isNaN(measuredDims.cols) && !isNaN(measuredDims.rows)) {
            pendingStatefulResizeDimensionsRef.current = measuredDims;
            notifyResizeDimensionsIfChanged(measuredDims.cols, measuredDims.rows);
          }
          onStatefulRedrawRequestRef.current?.();
          scheduleTerminalRefresh(term);
          return;
        }
        fitPreservingViewport();
      });
      observer.observe(host);

      return () => {
        inputObserver.disconnect();
        observer.disconnect();
        onDataDisposable.dispose();
        onScrollDisposable.dispose();
        host.removeEventListener('wheel', onWheel);
        searchResultsDisposable.dispose();
        if (viewport) {
          viewport.removeEventListener('scroll', onViewportScroll);
          viewport.removeEventListener('pointerdown', onViewportPointerDown);
          viewport.removeEventListener('pointerup', clearViewportScrollIntent);
          viewport.removeEventListener('pointercancel', clearViewportScrollIntent);
          viewport.removeEventListener('pointerleave', clearViewportScrollIntent);
        }
        userScrollIntentRef.current = false;
        flushOutgoingInput();
        fitAddonRef.current = null;
        fitAddon.dispose();
        searchAddon.dispose();
        writeQueueRef.current.setSink(null);
        writeQueueRef.current.clear();
        bulkWritingRef.current = false;
        isWritingRef.current = false;
        pendingStatefulResizeDimensionsRef.current = null;
        bulkWriteEpochRef.current += 1;
        fitWithReflowRef.current = null;
        lastReportedTerminalSizeRef.current = null;
        clearOptimisticSubmitCursorHide('dispose', { restoreCursor: true });
        clearDeferredInitialReplay();
        clearScheduledStreamRepair();
        bytesSinceRepairRef.current = 0;
        term.dispose();
        host.textContent = '';
        terminalRef.current = null;
        suppressPlainEnterUntilRef.current = 0;
        inputBufferRef.current = '';
        if (inputFlushTimerRef.current !== null) {
          window.clearTimeout(inputFlushTimerRef.current);
          inputFlushTimerRef.current = null;
        }
        if (refreshFrameRef.current !== null) {
          window.cancelAnimationFrame(refreshFrameRef.current);
          refreshFrameRef.current = null;
        }
        if (scrollRafRef.current !== null) {
          window.cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
        if (userViewportCaptureResetRafRef.current !== null) {
          window.cancelAnimationFrame(userViewportCaptureResetRafRef.current);
          userViewportCaptureResetRafRef.current = null;
        }
        if (pausedViewportCaptureRafRef.current !== null) {
          window.cancelAnimationFrame(pausedViewportCaptureRafRef.current);
          pausedViewportCaptureRafRef.current = null;
        }
        if (pausedViewportRestoreRafRef.current !== null) {
          window.cancelAnimationFrame(pausedViewportRestoreRafRef.current);
          pausedViewportRestoreRafRef.current = null;
        }
        userViewportCapturePendingRef.current = false;
        viewportPointerDownRef.current = false;
        pausedViewportScrollTopRef.current = null;
        pausedViewportScrollbackOffsetRef.current = null;
        searchAddonRef.current = null;
        logTerminalDebug('panel:dispose', {}, term);
      };
    } catch {
      logTerminalDebug('panel:fallback');
      setFallback(true);
      return;
    }
  }, [
    armOptimisticSubmitCursorHide,
    armUserViewportInteraction,
    capturePausedViewportScrollTop,
    clearDeferredInitialReplay,
    clearOptimisticSubmitCursorHide,
    clearPausedViewportScrollTop,
    fallback,
    estimateViewportScrollbackOffset,
    flushOutgoingInput,
    logTerminalDebug,
    maybeLogQueueHealth,
    openExternalLink,
    pauseFollowOutput,
    preferLiveRedrawOnMount,
    queueWrite,
    resumeFollowOutput,
    clearScheduledStreamRepair,
    getPreservedScrollbackOffset,
    schedulePausedViewportCapture,
    schedulePausedViewportRestore,
    scheduleStreamRepair,
    forceViewportToBottom,
    notifyResizeDimensionsIfChanged,
    notifyResizeIfChanged,
    scrollToBottomSoon,
    scheduleOutgoingInputFlush,
    shouldFreezeStatefulViewport,
    syncFollowOutputIndicator,
    terminalInstanceVersion,
    runTerminalSearch
  ]);

  useEffect(() => {
    writeQueueRef.current.setMaxBatchBytes(followOutputPaused ? OUTPUT_BATCH_BYTES_INTERACTIVE : OUTPUT_BATCH_BYTES);
  }, [followOutputPaused]);

  useEffect(() => {
    searchOpenRef.current = searchOpen;
    searchQueryRef.current = searchQuery;
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    const handle = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(handle);
    };
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) {
      clearSearchResults();
      return;
    }
    if (fallback) {
      setSearchResultCount(searchQuery ? 1 : 0);
      setSearchResultIndex(searchQuery ? 0 : -1);
      return;
    }
    if (!searchQuery) {
      clearSearchResults();
      return;
    }
    runTerminalSearch(searchQuery, 'next', true);
  }, [clearSearchResults, fallback, runTerminalSearch, searchOpen, searchQuery]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    inputEnabledRef.current = inputEnabled;
    cursorVisibleRef.current = cursorVisible;

    const term = terminalRef.current;
    if (!term) {
      previousInputEnabledRef.current = inputEnabled;
      return;
    }

    term.options.disableStdin = readOnly || !inputEnabled;
    term.write(cursorVisible ? DECTCEM_SHOW : DECTCEM_HIDE);

    const wasEnabled = previousInputEnabledRef.current;
    if (!wasEnabled && inputEnabled && !readOnly && shouldAutoFollow(followStateRef.current)) {
      logTerminalDebug('inputEnabled:auto-follow-scheduled', {}, term);
      scrollToBottomSoon(term);
      window.setTimeout(() => {
        if (terminalRef.current !== term) {
          return;
        }
        if (!shouldAutoFollow(followStateRef.current)) {
          logTerminalDebug('inputEnabled:auto-follow-timeout-skip-paused', {}, term);
          return;
        }
        logTerminalDebug('scrollToBottom:inputEnabled-timeout', {}, term);
        term.scrollToBottom();
      }, 80);
    }
    previousInputEnabledRef.current = inputEnabled;
  }, [cursorVisible, inputEnabled, logTerminalDebug, readOnly, scrollToBottomSoon]);

  useEffect(() => {
    if (sessionRef.current === sessionId) {
      return;
    }
    sessionRef.current = sessionId;
    statefulSessionRef.current = false;
    if (streamState?.sessionId === sessionId) {
      updateStatefulSessionMode(streamState.text);
      return;
    }
    updateStatefulSessionMode(contentRef.current);
  }, [contentRef, sessionId, streamState, updateStatefulSessionMode]);

  useEffect(() => {
    if (streamState) {
      return;
    }
    const term = terminalRef.current;
    if (!term) {
      sessionRef.current = sessionId;
      statefulSessionRef.current = Boolean(content && looksLikeStatefulTerminalUi(content));
      return;
    }

    if (sessionRef.current === sessionId) {
      return;
    }

    sessionRef.current = sessionId;
    statefulSessionRef.current = Boolean(contentRef.current && looksLikeStatefulTerminalUi(contentRef.current));
    followStateRef.current = createFollowState();
    syncFollowOutputIndicator(followStateRef.current.mode);
    clearOptimisticSubmitCursorHide('session-change');
    clearPendingWrites();
    clearScheduledStreamRepair();
    bytesSinceRepairRef.current = 0;
    suppressPlainEnterUntilRef.current = 0;
    inputBufferRef.current = '';
    if (inputFlushTimerRef.current !== null) {
      window.clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }

    resetTerminalContent(contentRef.current);
    renderedContentRef.current = contentRef.current;
    renderedByteCountRef.current = contentByteCount ?? contentRef.current.length;
    renderedGenerationRef.current = contentGeneration ?? 0;
    renderedStreamEndPositionRef.current = contentRef.current.length;
    renderedResetTokenRef.current = 0;
    scheduleTerminalRefresh(term);
  }, [
    clearOptimisticSubmitCursorHide,
    clearPendingWrites,
    clearScheduledStreamRepair,
    contentByteCount,
    contentGeneration,
    resetTerminalContent,
    scheduleTerminalRefresh,
    sessionId,
    streamState
  ]);

  useEffect(() => {
    if (previousSearchToggleRequestRef.current === searchToggleRequestId) {
      return;
    }
    previousSearchToggleRequestRef.current = searchToggleRequestId;
    setSearchOpen((current) => {
      const next = !current;
      if (!next) {
        clearSearchResults();
        window.requestAnimationFrame(() => {
          terminalRef.current?.focus();
        });
      }
      return next;
    });
  }, [clearSearchResults, searchToggleRequestId]);

  useEffect(() => {
    if (streamState) {
      return;
    }
    const term = terminalRef.current;
    if (!term) {
      return;
    }

    const rendered = renderedContentRef.current;
    const nextByteCount = contentByteCount ?? content.length;
    const nextGeneration = contentGeneration ?? 0;
    updateStatefulSessionMode(content);
    if (content === rendered && nextGeneration === renderedGenerationRef.current) {
      return;
    }

    const canAppendDirectly =
      Boolean(sessionId) &&
      !readOnly &&
      nextGeneration === renderedGenerationRef.current &&
      content.length >= rendered.length &&
      content.startsWith(rendered);

    if (canAppendDirectly) {
      const delta = content.slice(rendered.length);
      logTerminalDebug('content:append', {
        contentLength: content.length,
        renderedLength: rendered.length,
        deltaLength: delta.length,
        sessionId
      }, term);
      if (delta.length > 0) {
        queueWrite(delta);
      }
      renderedContentRef.current = content;
      renderedByteCountRef.current = nextByteCount;
      renderedGenerationRef.current = nextGeneration;
      renderedStreamEndPositionRef.current = content.length;
      renderedResetTokenRef.current = 0;
      if (shouldAutoFollow(followStateRef.current)) {
        scrollToBottomSoon(term);
      }
      return;
    }

    logTerminalDebug('content:reset', {
      contentLength: content.length,
      renderedLength: rendered.length,
      sessionId,
      readOnly,
      generationChanged: nextGeneration !== renderedGenerationRef.current
    }, term);
    resetTerminalContent(content, {
      preserveViewport: shouldPreserveViewport(followStateRef.current)
    });
    renderedContentRef.current = content;
    renderedByteCountRef.current = nextByteCount;
    renderedGenerationRef.current = nextGeneration;
    renderedStreamEndPositionRef.current = content.length;
    renderedResetTokenRef.current = 0;
    scheduleTerminalRefresh(term);
  }, [
    content,
    contentByteCount,
    contentGeneration,
    readOnly,
    resetTerminalContent,
    scheduleTerminalRefresh,
    sessionId,
    logTerminalDebug,
    queueWrite,
    scrollToBottomSoon,
    updateStatefulSessionMode,
  ]);

  useEffect(() => {
    if (!streamState) {
      return;
    }

    const term = terminalRef.current;
    if (!term) {
      return;
    }

    const statefulLiveScreen =
      sessionRef.current === streamState.sessionId &&
      (updateStatefulSessionMode(streamState.text) ||
        updateStatefulSessionMode(renderedContentRef.current || contentRef.current));
    const pendingStatefulResizeDimensions = pendingStatefulResizeDimensionsRef.current;
    const hasAuthoritativeStateAdvance =
      renderedResetTokenRef.current !== streamState.resetToken ||
      renderedStreamEndPositionRef.current !== streamState.endPosition ||
      renderedContentRef.current !== streamState.text;
    if (
      pendingStatefulResizeDimensions &&
      sessionRef.current === streamState.sessionId &&
      hasAuthoritativeStateAdvance
    ) {
      applyMeasuredLocalResize(term, pendingStatefulResizeDimensions);
      pendingStatefulResizeDimensionsRef.current = null;
      scheduleTerminalRefresh(term);
    }
    const freezeStatefulWhilePaused =
      sessionRef.current === streamState.sessionId &&
      shouldFreezeStatefulViewport() &&
      statefulLiveScreen;

    if (freezeStatefulWhilePaused) {
      logTerminalDebug('stream:freeze-stateful-paused', {
        renderedEndPosition: renderedStreamEndPositionRef.current,
        nextEndPosition: streamState.endPosition,
        renderedLength: renderedContentRef.current.length,
        nextLength: streamState.text.length
      }, term);
      scheduleTerminalRefresh(term);
      return;
    }

    if (renderedResetTokenRef.current !== streamState.resetToken) {
      renderedResetTokenRef.current = streamState.resetToken;
      renderedStreamEndPositionRef.current = streamState.endPosition;
      renderedContentRef.current = streamState.text;
      renderedByteCountRef.current = streamState.text.length;
      renderedGenerationRef.current = streamState.resetToken;
      resetTerminalContent(streamState.text, {
        preserveViewport: shouldPreserveViewport(followStateRef.current)
      });
      scheduleTerminalRefresh(term);
      return;
    }

    if (streamState.phase !== 'ready') {
      return;
    }

    const pendingChunks = streamState.chunks.filter(
      (chunk) => chunk.endPosition > renderedStreamEndPositionRef.current
    );
    if (pendingChunks.length === 0) {
      return;
    }

    const firstPendingChunk = pendingChunks[0];
    if (firstPendingChunk.startPosition > renderedStreamEndPositionRef.current) {
      const canReplayVisibleSuffix =
        renderedStreamEndPositionRef.current >= streamState.startPosition &&
        renderedStreamEndPositionRef.current <= streamState.endPosition;
      if (canReplayVisibleSuffix && !statefulLiveScreen) {
        const replayOffset = renderedStreamEndPositionRef.current - streamState.startPosition;
        const delta = streamState.text.slice(replayOffset);
        if (delta.length > 0) {
          queueWrite(delta);
        }
        renderedStreamEndPositionRef.current = streamState.endPosition;
        renderedContentRef.current = streamState.text;
        renderedByteCountRef.current = streamState.text.length;
        renderedGenerationRef.current = streamState.resetToken;
        if (shouldAutoFollow(followStateRef.current)) {
          scrollToBottomSoon(term);
        }
        return;
      }

      renderedStreamEndPositionRef.current = streamState.endPosition;
      renderedContentRef.current = streamState.text;
      renderedByteCountRef.current = streamState.text.length;
      renderedGenerationRef.current = streamState.resetToken;
      resetTerminalContent(streamState.text, {
        preserveViewport: shouldPreserveViewport(followStateRef.current)
      });
      scheduleTerminalRefresh(term);
      return;
    }

    const delta = pendingChunks.map((chunk) => {
      if (chunk.startPosition >= renderedStreamEndPositionRef.current) {
        return chunk.data;
      }
      return chunk.data.slice(renderedStreamEndPositionRef.current - chunk.startPosition);
    }).join('');

    if (delta.length > 0) {
      queueWrite(delta);
    }

    renderedStreamEndPositionRef.current = pendingChunks[pendingChunks.length - 1]?.endPosition ?? renderedStreamEndPositionRef.current;
    renderedContentRef.current = streamState.text;
    renderedByteCountRef.current = streamState.text.length;
    renderedGenerationRef.current = streamState.resetToken;
    if (shouldAutoFollow(followStateRef.current)) {
      scrollToBottomSoon(term);
    }
  }, [
    applyMeasuredLocalResize,
    logTerminalDebug,
    queueWrite,
    resetTerminalContent,
    scheduleTerminalRefresh,
    scrollToBottomSoon,
    shouldFreezeStatefulViewport,
    streamState,
    updateStatefulSessionMode
  ]);

  useEffect(() => {
    if (previousFocusRequestRef.current === focusRequestId) {
      return;
    }
    previousFocusRequestRef.current = focusRequestId;
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    term.focus();
    logTerminalDebug('focus:request', {}, term);
    window.requestAnimationFrame(() => {
      const fitAddon = fitAddonRef.current;
      if (!terminalRef.current || !fitAddon) {
        return;
      }
      // Use proposeDimensions + resize to avoid the clear() flash (see fitAndNotify).
      const dims = fitAddon.proposeDimensions();
      if (dims && !isNaN(dims.cols) && !isNaN(dims.rows) &&
          (terminalRef.current.cols !== dims.cols || terminalRef.current.rows !== dims.rows)) {
        terminalRef.current.resize(dims.cols, dims.rows);
      }
      notifyResizeIfChanged(terminalRef.current);
      scheduleTerminalRefresh(terminalRef.current);
    });
    if (shouldAutoFollow(followStateRef.current)) {
      scrollToBottomSoon(term);
    }
    syncFollowOutputIndicator(followStateRef.current.mode);
    scheduleTerminalRefresh(term);
  }, [focusRequestId, logTerminalDebug, notifyResizeIfChanged, scheduleTerminalRefresh, scrollToBottomSoon, syncFollowOutputIndicator]);

  useEffect(() => {
    if (previousRepairRequestRef.current === repairRequestId) {
      return;
    }
    previousRepairRequestRef.current = repairRequestId;
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    const preserveViewport = shouldPreserveViewport(followStateRef.current);
    pendingRepairStateRef.current = {
      preserveViewport,
      pausedViewportScrollTop: preserveViewport ? pausedViewportScrollTopRef.current : null,
      scrollbackOffset: preserveViewport
        ? getPreservedScrollbackOffset(term, 'repair-request')
        : 0
    };
    logTerminalDebug('repair:request', {
      preserveViewport,
      pausedViewportScrollTop: pendingRepairStateRef.current.pausedViewportScrollTop,
      scrollbackOffset: pendingRepairStateRef.current.scrollbackOffset
    }, term);
    clearPendingWrites();
    clearScheduledStreamRepair();
    bulkWriteEpochRef.current += 1;
    streamRepairEpochRef.current += 1;
    setTerminalInstanceVersion((current) => current + 1);
  }, [clearPendingWrites, clearScheduledStreamRepair, getPreservedScrollbackOffset, logTerminalDebug, repairRequestId]);

  const jumpToLatest = useCallback(() => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    resumeFollowOutput(term, 'follow:jump-latest');
  }, [resumeFollowOutput]);

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

  const searchResultLabel =
    searchResultCount > 0
      ? `${Math.max(1, searchResultIndex + 1)} / ${searchResultCount}`
      : searchQuery
        ? '0 results'
        : 'Find';

  if (fallback) {
    return (
      <section
        className={searchOpen ? 'terminal-panel terminal-panel-search-open' : 'terminal-panel'}
        onFocusCapture={handlePanelFocusCapture}
        onBlurCapture={handlePanelBlurCapture}
      >
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
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
              />
            </div>
            <span className="terminal-search-count" data-testid="terminal-search-count">
              Renderer fallback
            </span>
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
        <pre className="terminal-fallback">{content}</pre>
        {terminalDebugEnabled && terminalDebugLines.length > 0 ? (
          <pre
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: searchOpen ? 54 : 10,
              right: 10,
              width: 480,
              maxHeight: 240,
              margin: 0,
              padding: '8px 10px',
              overflow: 'hidden',
              borderRadius: 8,
              background: 'rgba(4, 10, 20, 0.92)',
              border: '1px solid rgba(122, 152, 214, 0.24)',
              color: '#b9d2ff',
              fontSize: 10,
              lineHeight: 1.35,
              whiteSpace: 'pre-wrap',
              pointerEvents: 'none',
              zIndex: 4
            }}
          >
            {terminalDebugLines.join('\n')}
          </pre>
        ) : null}
        {overlayMessage ? <div className="terminal-overlay">{overlayMessage}</div> : null}
      </section>
    );
  }

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
          <button type="button" className="terminal-follow-button" onClick={jumpToLatest}>
            Jump to latest
          </button>
        </div>
      ) : null}
      {terminalDebugEnabled && terminalDebugLines.length > 0 ? (
        <pre
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: searchOpen ? 54 : 10,
            right: 10,
            width: 480,
            maxHeight: 240,
            margin: 0,
            padding: '8px 10px',
            overflow: 'hidden',
            borderRadius: 8,
            background: 'rgba(4, 10, 20, 0.92)',
            border: '1px solid rgba(122, 152, 214, 0.24)',
            color: '#b9d2ff',
            fontSize: 10,
            lineHeight: 1.35,
            whiteSpace: 'pre-wrap',
            pointerEvents: 'none',
            zIndex: 4
          }}
        >
          {terminalDebugLines.join('\n')}
        </pre>
      ) : null}
      {overlayMessage ? <div className="terminal-overlay">{overlayMessage}</div> : null}
    </section>
  );
}
