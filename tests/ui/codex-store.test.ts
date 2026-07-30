import { describe, expect, it } from 'vitest';

import {
  coalesceCodexEvents,
  CodexStore,
  reduceCodexEvent,
  type CodexStoreSnapshot
} from '../../src/stores/codexStore';
import type { CodexEvent, CodexThread } from '../../src/types';

function thread(): CodexThread {
  return {
    id: 'thread-1',
    sessionId: 'thread-1',
    title: 'Structured thread',
    preview: 'Working on the task',
    cwd: '/tmp/project',
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    status: 'active',
    source: 'appServer',
    cliVersion: '0.144.0',
    archived: false,
    turns: []
  };
}

function snapshot(): CodexStoreSnapshot {
  return {
    threads: { 'thread-1': thread() },
    sessions: {},
    approvals: {},
    usage: {},
    activeThreadId: 'thread-1',
    diagnostics: null,
    lastSequence: 0,
    unseenEvents: 0
  };
}

function event(overrides: Partial<CodexEvent>): CodexEvent {
  return {
    sequence: 1,
    kind: 'generic',
    method: 'unknown/event',
    threadId: 'thread-1',
    ...overrides
  };
}

describe('structured Codex event reduction', () => {
  it('coalesces adjacent high-frequency deltas without crossing item boundaries', () => {
    const events = coalesceCodexEvents([
      event({
        sequence: 1,
        kind: 'agentMessageDelta',
        method: 'item/agentMessage/delta',
        turnId: 'turn-1',
        itemId: 'agent-1',
        delta: 'Hello'
      }),
      event({
        sequence: 2,
        kind: 'agentMessageDelta',
        method: 'item/agentMessage/delta',
        turnId: 'turn-1',
        itemId: 'agent-1',
        delta: ' world'
      }),
      event({
        sequence: 3,
        kind: 'agentMessageDelta',
        method: 'item/agentMessage/delta',
        turnId: 'turn-1',
        itemId: 'agent-2',
        delta: 'Separate'
      })
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sequence: 2,
      itemId: 'agent-1',
      delta: 'Hello world'
    });
    expect(events[1]).toMatchObject({
      sequence: 3,
      itemId: 'agent-2',
      delta: 'Separate'
    });
  });

  it('keeps unchanged store slices referentially stable for generic events', () => {
    const before = snapshot();
    const after = reduceCodexEvent(
      before,
      event({
        sequence: 1,
        kind: 'generic',
        method: 'future/diagnostic',
        threadId: 'thread-1'
      })
    );

    expect(after.threads).toBe(before.threads);
    expect(after.approvals).toBe(before.approvals);
    expect(after.usage).toBe(before.usage);
    expect(after.lastSequence).toBe(1);
  });

  it('accepts item events before turn responses and streams into only that item', () => {
    let state = reduceCodexEvent(
      snapshot(),
      event({
        sequence: 1,
        kind: 'itemStarted',
        method: 'item/started',
        turnId: 'turn-1',
        itemId: 'command-1',
        item: {
          id: 'command-1',
          kind: 'commandExecution',
          status: 'inProgress',
          command: 'yarn test',
          summary: [],
          reasoning: [],
          content: [],
          changes: []
        }
      })
    );
    state = reduceCodexEvent(
      state,
      event({
        sequence: 2,
        kind: 'commandOutputDelta',
        method: 'item/commandExecution/outputDelta',
        turnId: 'turn-1',
        itemId: 'command-1',
        delta: 'running\n'
      })
    );
    state = reduceCodexEvent(
      state,
      event({
        sequence: 3,
        kind: 'commandOutputDelta',
        method: 'item/commandExecution/outputDelta',
        turnId: 'turn-1',
        itemId: 'command-1',
        delta: 'passed\n'
      })
    );

    const turn = state.threads['thread-1'].turns[0];
    expect(turn.id).toBe('turn-1');
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0].output).toBe('running\npassed\n');
  });

  it('bounds pathological streaming command output while retaining the newest data', () => {
    const state = reduceCodexEvent(
      snapshot(),
      event({
        sequence: 1,
        kind: 'commandOutputDelta',
        method: 'item/commandExecution/outputDelta',
        turnId: 'turn-large',
        itemId: 'command-large',
        delta: `${'a'.repeat(1_000_050)}latest`
      })
    );
    const output = state.threads['thread-1'].turns[0].items[0].output ?? '';
    expect(output).toMatch(/^\[Earlier command output truncated\]/);
    expect(output).toHaveLength(1_000_035);
    expect(output.endsWith('latest')).toBe(true);
  });

  it('preserves separate streamed reasoning summary parts', () => {
    let state = snapshot();
    for (const update of [
      { kind: 'reasoningSummaryPartAdded', delta: '', sequence: 1 },
      { kind: 'reasoningSummaryDelta', delta: 'Inspect', sequence: 2 },
      { kind: 'reasoningSummaryPartAdded', delta: '', sequence: 3 },
      { kind: 'reasoningSummaryDelta', delta: 'Implement', sequence: 4 }
    ]) {
      state = reduceCodexEvent(
        state,
        event({
          ...update,
          method:
            update.kind === 'reasoningSummaryPartAdded'
              ? 'item/reasoning/summaryPartAdded'
              : 'item/reasoning/summaryTextDelta',
          turnId: 'turn-reasoning',
          itemId: 'reasoning-1'
        })
      );
    }
    expect(state.threads['thread-1'].turns[0].items[0].summary).toEqual([
      'Inspect',
      'Implement'
    ]);
  });

  it('deduplicates repeated notifications and item completion payloads', () => {
    const started = event({
      sequence: 4,
      kind: 'turnStarted',
      method: 'turn/started',
      turn: { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'full' }
    });
    let state = reduceCodexEvent(snapshot(), started);
    expect(reduceCodexEvent(state, started)).toBe(state);

    state = reduceCodexEvent(
      state,
      event({
        sequence: 5,
        kind: 'itemCompleted',
        method: 'item/completed',
        turnId: 'turn-1',
        item: {
          id: 'agent-1',
          kind: 'agentMessage',
          status: 'completed',
          text: 'Done.',
          summary: [],
          reasoning: [],
          content: [],
          changes: []
        }
      })
    );
    state = reduceCodexEvent(
      state,
      event({
        sequence: 6,
        kind: 'itemCompleted',
        method: 'item/completed',
        turnId: 'turn-1',
        item: {
          id: 'agent-1',
          kind: 'agentMessage',
          status: 'completed',
          text: 'Done.',
          summary: [],
          reasoning: [],
          content: [],
          changes: []
        }
      })
    );
    expect(state.threads['thread-1'].turns[0].items).toHaveLength(1);
  });

  it('preserves unknown events and records approvals without corrupting the thread', () => {
    let state = reduceCodexEvent(
      snapshot(),
      event({ sequence: 1, kind: 'generic', method: 'future/newNotification', data: { value: 1 } })
    );
    expect(state.threads['thread-1'].title).toBe('Structured thread');

    state = reduceCodexEvent(
      state,
      event({
        sequence: 2,
        kind: 'approvalRequested',
        method: 'item/commandExecution/requestApproval',
        approval: {
          requestId: 42,
          approvalType: 'commandExecution',
          threadId: 'thread-1',
          turnId: 'turn-1',
          command: 'git push',
          availableDecisions: ['accept', 'decline']
        }
      })
    );
    expect(state.approvals['42']?.command).toBe('git push');
  });

  it('marks archived lifecycle state without mixing it into active state', () => {
    const state = reduceCodexEvent(
      snapshot(),
      event({ sequence: 1, kind: 'threadArchived', method: 'thread/archived' })
    );
    expect(state.threads['thread-1'].archived).toBe(true);
  });

  it('resolves approvals whose protocol request IDs are numeric', () => {
    let state = reduceCodexEvent(
      snapshot(),
      event({
        sequence: 1,
        approval: {
          requestId: 42,
          approvalType: 'commandExecution',
          threadId: 'thread-1',
          availableDecisions: ['accept', 'decline']
        }
      })
    );
    state = reduceCodexEvent(
      state,
      event({
        sequence: 2,
        kind: 'approvalResolved',
        method: 'serverRequest/resolved',
        data: { requestId: 42 }
      })
    );
    expect(state.approvals).toEqual({});
  });

  it('removes all local state for a thread even when Codex omits thread/deleted', () => {
    const store = new CodexStore();
    store.setSession({
      thread: thread(),
      settings: {
        requestedModel: null,
        effectiveModel: 'runtime-model',
        modelResolution: 'runtimeDefault',
        requestedReasoningEffort: null,
        effectiveReasoningEffort: 'high',
        reasoningEffortResolution: 'runtimeDefault',
        requestedServiceTier: null,
        effectiveServiceTier: null,
        serviceTierResolution: 'runtimeDefault',
        permissionMode: 'fullAccess',
        permissionProfile: 'fullAccess',
        approvalPolicy: 'never',
        sandboxPolicy: 'danger-full-access',
        cwd: '/tmp/project'
      },
      instructionSources: []
    });
    store.setActiveThread('thread-1');
    store.queueEvent(
      event({
        sequence: 1,
        kind: 'approvalRequested',
        approval: {
          requestId: 7,
          approvalType: 'commandExecution',
          threadId: 'thread-1',
          availableDecisions: ['accept', 'decline']
        },
        tokenUsage: {
          totalTokens: 12,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          lastTotalTokens: 12,
          modelContextWindow: 100
        }
      })
    );
    store.flushEvents();

    store.removeThread('thread-1');

    expect(store.getSnapshot().threads).toEqual({});
    expect(store.getSnapshot().sessions).toEqual({});
    expect(store.getSnapshot().approvals).toEqual({});
    expect(store.getSnapshot().usage).toEqual({});
    expect(store.getSnapshot().activeThreadId).toBeNull();
  });

  it('drops queued activity for a thread removed through the compatibility path', () => {
    const store = new CodexStore();
    store.upsertThreads([thread()]);
    store.queueEvent(
      event({
        sequence: 1,
        kind: 'agentMessageDelta',
        method: 'item/agentMessage/delta',
        turnId: 'turn-1',
        itemId: 'agent-1',
        delta: 'late output'
      })
    );

    store.removeThread('thread-1');
    store.flushEvents();

    expect(store.getSnapshot().threads).toEqual({});
  });
});
