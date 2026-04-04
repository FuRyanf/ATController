export type TerminalRunPhase = 'starting' | 'ready' | 'streaming' | 'exited';

export interface TerminalRunLifecycleState {
  phase: TerminalRunPhase;
  updatedAtMs: number;
  streamingSinceMs: number | null;
  lastMeaningfulOutputAtMs: number | null;
}

export function createRunLifecycleState(nowMs: number = Date.now()): TerminalRunLifecycleState {
  return {
    phase: 'starting',
    updatedAtMs: nowMs,
    streamingSinceMs: null,
    lastMeaningfulOutputAtMs: null
  };
}

export function markRunReady(
  state: TerminalRunLifecycleState | undefined,
  nowMs: number = Date.now()
): TerminalRunLifecycleState {
  return {
    phase: 'ready',
    updatedAtMs: nowMs,
    streamingSinceMs: null,
    lastMeaningfulOutputAtMs: state?.lastMeaningfulOutputAtMs ?? null
  };
}

export function markRunStreaming(
  state: TerminalRunLifecycleState | undefined,
  nowMs: number = Date.now()
): TerminalRunLifecycleState {
  return {
    phase: 'streaming',
    updatedAtMs: nowMs,
    streamingSinceMs: nowMs,
    lastMeaningfulOutputAtMs: state?.lastMeaningfulOutputAtMs ?? null
  };
}

export function markRunExited(nowMs: number = Date.now()): TerminalRunLifecycleState {
  return {
    phase: 'exited',
    updatedAtMs: nowMs,
    streamingSinceMs: null,
    lastMeaningfulOutputAtMs: null
  };
}

export function noteRunOutput(
  state: TerminalRunLifecycleState | undefined,
  meaningful: boolean,
  nowMs: number = Date.now()
): TerminalRunLifecycleState {
  if (!state) {
    return {
      phase: meaningful ? 'ready' : 'starting',
      updatedAtMs: nowMs,
      streamingSinceMs: null,
      lastMeaningfulOutputAtMs: meaningful ? nowMs : null
    };
  }

  if (!meaningful) {
    return {
      ...state,
      updatedAtMs: nowMs
    };
  }

  return {
    ...state,
    updatedAtMs: nowMs,
    lastMeaningfulOutputAtMs: nowMs
  };
}

export function isStreamingStuck(
  state: TerminalRunLifecycleState | undefined,
  nowMs: number,
  timeoutMs: number
): boolean {
  if (!state || state.phase !== 'streaming') {
    return false;
  }

  const base = state.lastMeaningfulOutputAtMs ?? state.streamingSinceMs ?? state.updatedAtMs;
  return nowMs - base >= timeoutMs;
}
