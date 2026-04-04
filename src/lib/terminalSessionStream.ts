import type { TerminalDataEvent, TerminalOutputSnapshot } from '../types';

export type TerminalStreamPhase = 'idle' | 'hydrating' | 'ready';

export interface TerminalStreamChunk {
  rawStartPosition: number;
  rawEndPosition: number;
  startPosition: number;
  endPosition: number;
  data: string;
}

export interface TerminalSessionStreamState {
  sessionId: string | null;
  phase: TerminalStreamPhase;
  text: string;
  rawEndPosition: number;
  startPosition: number;
  endPosition: number;
  chunks: TerminalStreamChunk[];
  resetToken: number;
}

export function terminalSessionStreamKnownRawEndPosition(state: TerminalSessionStreamState): number {
  const bufferedRawEndPosition = state.chunks[state.chunks.length - 1]?.rawEndPosition ?? 0;
  return Math.max(state.rawEndPosition, bufferedRawEndPosition);
}

export function createTerminalSessionStreamState(): TerminalSessionStreamState {
  return {
    sessionId: null,
    phase: 'idle',
    text: '',
    rawEndPosition: 0,
    startPosition: 0,
    endPosition: 0,
    chunks: [],
    resetToken: 0
  };
}

function clampStreamWindow(
  text: string,
  startPosition: number,
  endPosition: number,
  maxChars: number
): Pick<TerminalSessionStreamState, 'text' | 'startPosition' | 'endPosition'> {
  if (maxChars <= 0 || text.length <= maxChars) {
    return {
      text,
      startPosition,
      endPosition
    };
  }

  const trimChars = text.length - maxChars;
  return {
    text: text.slice(trimChars),
    startPosition: startPosition + trimChars,
    endPosition
  };
}

function normalizeChunk(chunk: TerminalStreamChunk, minStartPosition: number): TerminalStreamChunk | null {
  if (chunk.endPosition <= minStartPosition) {
    return null;
  }
  if (chunk.startPosition >= minStartPosition) {
    return chunk;
  }

  const trimChars = minStartPosition - chunk.startPosition;
  return {
    rawStartPosition: chunk.rawStartPosition,
    rawEndPosition: chunk.rawEndPosition,
    startPosition: minStartPosition,
    endPosition: chunk.endPosition,
    data: chunk.data.slice(trimChars)
  };
}

function appendChunkToBuffer(chunks: TerminalStreamChunk[], incoming: TerminalStreamChunk): TerminalStreamChunk[] {
  const last = chunks[chunks.length - 1];
  if (!last) {
    return [incoming];
  }
  if (incoming.rawEndPosition <= last.rawEndPosition) {
    return chunks;
  }
  if (incoming.rawStartPosition >= last.rawEndPosition) {
    return [...chunks, incoming];
  }
  return chunks;
}

function trimChunksToWindow(chunks: TerminalStreamChunk[], windowStartPosition: number): TerminalStreamChunk[] {
  const next: TerminalStreamChunk[] = [];
  for (const chunk of chunks) {
    const normalized = normalizeChunk(chunk, windowStartPosition);
    if (!normalized || normalized.data.length === 0) {
      continue;
    }
    next.push(normalized);
  }
  return next;
}

function applyChunkToText(
  state: Pick<TerminalSessionStreamState, 'text' | 'startPosition' | 'endPosition'>,
  chunk: TerminalStreamChunk,
  maxChars: number
): Pick<TerminalSessionStreamState, 'text' | 'startPosition' | 'endPosition'> {
  if (chunk.endPosition <= state.endPosition) {
    return state;
  }

  let normalizedChunk = chunk;
  if (chunk.startPosition < state.endPosition) {
    const overlapChars = state.endPosition - chunk.startPosition;
    normalizedChunk = {
      rawStartPosition: chunk.rawStartPosition,
      rawEndPosition: chunk.rawEndPosition,
      startPosition: state.endPosition,
      endPosition: chunk.endPosition,
      data: chunk.data.slice(overlapChars)
    };
  }

  if (normalizedChunk.data.length === 0) {
    return {
      ...state,
      endPosition: Math.max(state.endPosition, normalizedChunk.endPosition)
    };
  }

  return clampStreamWindow(
    `${state.text}${normalizedChunk.data}`,
    state.startPosition,
    normalizedChunk.endPosition,
    maxChars
  );
}

function buildVisibleChunk(
  rawStartPosition: number,
  rawEndPosition: number,
  data: string,
  visibleStartPosition: number
): TerminalStreamChunk {
  return {
    rawStartPosition,
    rawEndPosition,
    startPosition: visibleStartPosition,
    endPosition: visibleStartPosition + data.length,
    data
  };
}

export function bindTerminalSessionStream(
  state: TerminalSessionStreamState,
  sessionId: string | null
): TerminalSessionStreamState {
  return {
    sessionId,
    phase: sessionId ? 'hydrating' : 'idle',
    text: '',
    rawEndPosition: 0,
    startPosition: 0,
    endPosition: 0,
    chunks: [],
    resetToken: state.resetToken + 1
  };
}

export function bindLiveTerminalSessionStream(
  state: TerminalSessionStreamState,
  sessionId: string | null
): TerminalSessionStreamState {
  return {
    sessionId,
    phase: sessionId ? 'ready' : 'idle',
    text: '',
    rawEndPosition: 0,
    startPosition: 0,
    endPosition: 0,
    chunks: [],
    resetToken: state.resetToken + 1
  };
}

export function presentTerminalSnapshot(
  state: TerminalSessionStreamState,
  snapshot: TerminalOutputSnapshot,
  maxChars: number
): TerminalSessionStreamState {
  const nextWindow = clampStreamWindow(
    snapshot.text,
    0,
    snapshot.text.length,
    maxChars
  );

  if (state.phase === 'ready') {
    if (snapshot.endPosition < state.rawEndPosition) {
      return state;
    }
    if (
      snapshot.endPosition === state.rawEndPosition &&
      nextWindow.text === state.text &&
      nextWindow.startPosition === state.startPosition &&
      nextWindow.endPosition === state.endPosition
    ) {
      return state;
    }
  }

  return {
    ...state,
    phase: 'ready',
    text: nextWindow.text,
    rawEndPosition: snapshot.endPosition,
    startPosition: nextWindow.startPosition,
    endPosition: nextWindow.endPosition,
    chunks: [],
    resetToken: state.resetToken + 1
  };
}

export function appendTerminalStreamChunk(
  state: TerminalSessionStreamState,
  event: Pick<TerminalDataEvent, 'sessionId' | 'startPosition' | 'endPosition' | 'data'>,
  maxChars: number
): TerminalSessionStreamState {
  if (state.sessionId !== event.sessionId) {
    return state;
  }

  const incomingChunk: TerminalStreamChunk = {
    rawStartPosition: event.startPosition,
    rawEndPosition: event.endPosition,
    startPosition: 0,
    endPosition: event.data.length,
    data: event.data
  };

  if (state.phase === 'hydrating') {
    const nextChunks = appendChunkToBuffer(state.chunks, incomingChunk);
    if (nextChunks === state.chunks) {
      return state;
    }
    return {
      ...state,
      chunks: nextChunks
    };
  }

  if (incomingChunk.rawEndPosition <= state.rawEndPosition) {
    return state;
  }

  const visibleChunk = buildVisibleChunk(
    incomingChunk.rawStartPosition,
    incomingChunk.rawEndPosition,
    incomingChunk.data,
    state.endPosition
  );
  const nextWindow = applyChunkToText(state, visibleChunk, maxChars);
  if (
    nextWindow.text === state.text &&
    nextWindow.startPosition === state.startPosition &&
    nextWindow.endPosition === state.endPosition
  ) {
    return {
      ...state,
      rawEndPosition: incomingChunk.rawEndPosition
    };
  }

  const nextChunks = trimChunksToWindow(
    appendChunkToBuffer(
      state.chunks,
      normalizeChunk(visibleChunk, nextWindow.startPosition) ?? visibleChunk
    ),
    nextWindow.startPosition
  );

  return {
    ...state,
    text: nextWindow.text,
    rawEndPosition: incomingChunk.rawEndPosition,
    startPosition: nextWindow.startPosition,
    endPosition: nextWindow.endPosition,
    chunks: nextChunks
  };
}

export function hydrateTerminalSessionStream(
  state: TerminalSessionStreamState,
  sessionId: string,
  snapshot: TerminalOutputSnapshot,
  maxChars: number
): TerminalSessionStreamState {
  if (state.sessionId !== sessionId || state.phase !== 'hydrating') {
    return state;
  }

  let nextWindow = clampStreamWindow(
    snapshot.text,
    0,
    snapshot.text.length,
    maxChars
  );
  let nextChunks: TerminalStreamChunk[] = [];
  let nextRawEndPosition = snapshot.endPosition;

  for (const chunk of state.chunks) {
    if (chunk.rawEndPosition <= snapshot.endPosition) {
      continue;
    }
    const visibleChunk = buildVisibleChunk(
      chunk.rawStartPosition,
      chunk.rawEndPosition,
      chunk.data,
      nextWindow.endPosition
    );
    nextWindow = applyChunkToText(nextWindow, visibleChunk, maxChars);
    const clampedVisibleChunk = normalizeChunk(visibleChunk, nextWindow.startPosition);
    if (!clampedVisibleChunk || clampedVisibleChunk.data.length === 0) {
      nextRawEndPosition = chunk.rawEndPosition;
      continue;
    }
    nextChunks = appendChunkToBuffer(nextChunks, clampedVisibleChunk);
    nextChunks = trimChunksToWindow(nextChunks, nextWindow.startPosition);
    nextRawEndPosition = chunk.rawEndPosition;
  }

  return {
    ...state,
    phase: 'ready',
    text: nextWindow.text,
    rawEndPosition: nextRawEndPosition,
    startPosition: nextWindow.startPosition,
    endPosition: nextWindow.endPosition,
    chunks: nextChunks,
    resetToken: state.resetToken + 1
  };
}
