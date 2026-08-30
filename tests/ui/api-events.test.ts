import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

const eventMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: new Map<string, ReturnType<typeof vi.fn>>()
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      name: string,
      handler: (event: { payload: unknown }) => void
    ) => {
      eventMock.handlers.set(name, handler);
      const unlisten = vi.fn(() => eventMock.handlers.delete(name));
      eventMock.unlisten.set(name, unlisten);
      return unlisten;
    }
  )
}));

import { api, events, onCodexEvent } from '../../src/lib/api';
import type { CodexEvent } from '../../src/types';

function codexEvent(sequence: number): CodexEvent {
  return {
    sequence,
    kind: 'generic',
    method: `test/event/${sequence}`,
    threadId: 'thread-1'
  };
}

beforeEach(() => {
  eventMock.handlers.clear();
  eventMock.unlisten.clear();
  vi.mocked(invoke).mockReset();
});

describe('Codex UI event transport', () => {
  it('delivers ordered batches and retains single-event compatibility', async () => {
    const received: number[] = [];
    const unlisten = await onCodexEvent((event) =>
      received.push(event.sequence)
    );

    eventMock.handlers.get(events.codexEventBatch)?.({
      payload: [codexEvent(1), codexEvent(2), codexEvent(3)]
    });
    eventMock.handlers.get(events.codexEvent)?.({ payload: codexEvent(4) });

    expect(received).toEqual([1, 2, 3, 4]);
    unlisten();
    expect(eventMock.unlisten.get(events.codexEvent)).toHaveBeenCalledOnce();
    expect(
      eventMock.unlisten.get(events.codexEventBatch)
    ).toHaveBeenCalledOnce();
  });
});

describe('browser diagnostics transport', () => {
  it('keeps routine diagnostics local by default', async () => {
    await api.getBrowserDiagnostics('thread-1');

    expect(invoke).toHaveBeenCalledWith('browser_get_diagnostics', {
      threadId: 'thread-1',
      probeRuntime: false
    });
  });

  it('requests a full MCP probe only when explicitly asked', async () => {
    await api.getBrowserDiagnostics('thread-1', true);

    expect(invoke).toHaveBeenCalledWith('browser_get_diagnostics', {
      threadId: 'thread-1',
      probeRuntime: true
    });
  });
});
