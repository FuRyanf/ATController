interface TerminalDebugEvent {
  id: number;
  at: number;
  scope: string;
  data: Record<string, unknown>;
}

const MAX_TERMINAL_DEBUG_EVENTS = 200;

let nextTerminalDebugEventId = 1;
let terminalDebugEvents: TerminalDebugEvent[] = [];

const terminalDebugListeners = new Set<(events: readonly TerminalDebugEvent[]) => void>();

function notifyTerminalDebugListeners() {
  for (const listener of terminalDebugListeners) {
    listener(terminalDebugEvents);
  }
}

function serializeTerminalDebugValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeTerminalDebugValue(item)).join(',')}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isTerminalDebugEnabled(): boolean {
  if (import.meta.env.MODE === 'test') {
    return false;
  }
  if (
    (
      globalThis as {
        __ATCONTROLLER_TERMINAL_DEBUG__?: boolean;
      }
    ).__ATCONTROLLER_TERMINAL_DEBUG__ === true
  ) {
    return true;
  }
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem('atcontroller:terminal-debug') === '1';
  } catch {
    return false;
  }
}

export function pushTerminalDebug(scope: string, data: Record<string, unknown> = {}) {
  if (!isTerminalDebugEnabled()) {
    return;
  }

  const nextEvent: TerminalDebugEvent = {
    id: nextTerminalDebugEventId,
    at: Date.now(),
    scope,
    data
  };
  nextTerminalDebugEventId += 1;

  terminalDebugEvents =
    terminalDebugEvents.length >= MAX_TERMINAL_DEBUG_EVENTS
      ? [...terminalDebugEvents.slice(-(MAX_TERMINAL_DEBUG_EVENTS - 1)), nextEvent]
      : [...terminalDebugEvents, nextEvent];
  notifyTerminalDebugListeners();

  try {
    console.info('[terminal-debug]', formatTerminalDebugEvent(nextEvent));
  } catch {
    // best effort
  }
}

export function subscribeTerminalDebug(
  listener: (events: readonly TerminalDebugEvent[]) => void
): () => void {
  terminalDebugListeners.add(listener);
  listener(terminalDebugEvents);
  return () => {
    terminalDebugListeners.delete(listener);
  };
}

export function clearTerminalDebug() {
  if (terminalDebugEvents.length === 0 && nextTerminalDebugEventId === 1) {
    return;
  }
  terminalDebugEvents = [];
  nextTerminalDebugEventId = 1;
  notifyTerminalDebugListeners();
}

export function formatTerminalDebugEvent(event: TerminalDebugEvent): string {
  const time = new Date(event.at).toISOString().slice(11, 23);
  const payload = Object.entries(event.data)
    .map(([key, value]) => `${key}=${serializeTerminalDebugValue(value)}`)
    .join(' ');
  return payload ? `${String(event.id).padStart(4, '0')} ${time} ${event.scope} ${payload}` : `${String(event.id).padStart(4, '0')} ${time} ${event.scope}`;
}
