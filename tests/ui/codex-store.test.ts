import { describe, expect, it } from 'vitest';

import { reduceCodexEvent, type CodexStoreSnapshot } from '../../src/stores/codexStore';
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
});
