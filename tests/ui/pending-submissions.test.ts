import { describe, expect, it } from 'vitest';

import {
  acceptPendingSubmission,
  createPendingSubmission,
  eventAcknowledgesSubmission,
  reconcilePendingSubmissions,
  reconcileTurnStartResponse,
  removePendingSubmission,
  unacknowledgedSubmissions,
  updatePendingSubmissionStatus
} from '../../src/lib/pendingSubmissions';
import type {
  CodexEvent,
  CodexItem,
  CodexThread,
  CodexTurn,
  ComposerInput
} from '../../src/types';

function userMessage(clientId: string | null, text: string): CodexItem {
  return {
    id: `user-${clientId ?? 'legacy'}`,
    clientId,
    kind: 'userMessage',
    content: [{ kind: 'text', text }],
    summary: [],
    reasoning: [],
    changes: []
  };
}

function itemEvent(threadId: string, item: CodexItem): CodexEvent {
  return {
    sequence: 1,
    kind: 'itemStarted',
    method: 'item/started',
    threadId,
    turnId: 'turn-1',
    itemId: item.id,
    item
  };
}

describe('optimistic user submissions', () => {
  it('creates a safe preview without retaining inline image data', () => {
    const inputs: ComposerInput[] = [
      { type: 'text', text: 'Review these inputs' },
      { type: 'image', url: 'data:image/png;base64,SECRET_IMAGE_BYTES' },
      { type: 'file', name: 'notes.md', path: '/tmp/project/notes.md' },
      { type: 'skill', name: 'review', path: '/tmp/project/.github/skills/review/SKILL.md' },
      { type: 'plugin', id: 'browser@openai', name: 'Browser' }
    ];

    const pending = createPendingSubmission(
      'thread-1',
      'client-1',
      'turn',
      inputs,
      42
    );

    expect(pending).toMatchObject({
      clientId: 'client-1',
      threadId: 'thread-1',
      mode: 'turn',
      status: 'sending',
      text: 'Review these inputs',
      submittedAt: 42,
      resources: [
        { kind: 'image', label: 'Pasted image' },
        { kind: 'file', label: 'notes.md' },
        { kind: 'skill', label: 'review' },
        { kind: 'plugin', label: 'Browser' }
      ]
    });
    expect(JSON.stringify(pending)).not.toContain('SECRET_IMAGE_BYTES');
  });

  it('reconciles only the matching thread and echoed client message id', () => {
    const first = createPendingSubmission(
      'thread-1',
      'client-1',
      'turn',
      [{ type: 'text', text: 'Same prompt' }]
    );
    const second = createPendingSubmission(
      'thread-2',
      'client-2',
      'turn',
      [{ type: 'text', text: 'Same prompt' }]
    );
    const current = { 'thread-1': [first], 'thread-2': [second] };

    expect(
      reconcilePendingSubmissions(
        current,
        itemEvent('thread-1', userMessage('client-1', 'Same prompt'))
      )
    ).toEqual({ 'thread-2': [second] });
    expect(
      eventAcknowledgesSubmission(
        itemEvent('thread-1', userMessage('client-2', 'Same prompt')),
        first
      )
    ).toBe(false);
  });

  it('falls back to matching user text for compatible runtimes without client ids', () => {
    const pending = createPendingSubmission(
      'thread-1',
      'client-1',
      'steer',
      [{ type: 'text', text: 'Change direction' }]
    );

    expect(
      eventAcknowledgesSubmission(
        itemEvent('thread-1', userMessage(null, 'Change direction')),
        pending
      )
    ).toBe(true);
    expect(
      eventAcknowledgesSubmission(
        itemEvent('thread-1', userMessage(null, 'A different message')),
        pending
      )
    ).toBe(false);
  });

  it('matches repeated legacy messages one-to-one instead of consuming every duplicate', () => {
    const first = createPendingSubmission(
      'thread-1',
      'client-1',
      'turn',
      [{ type: 'text', text: 'Repeat this' }],
      1
    );
    const second = createPendingSubmission(
      'thread-1',
      'client-2',
      'turn',
      [{ type: 'text', text: 'Repeat this' }],
      2
    );

    expect(
      reconcilePendingSubmissions(
        { 'thread-1': [first, second] },
        itemEvent('thread-1', userMessage(null, 'Repeat this'))
      )
    ).toEqual({ 'thread-1': [second] });
  });

  it('keeps a bound submission until the actual user item arrives after completion', () => {
    const pending = createPendingSubmission(
      'thread-1',
      'client-1',
      'turn',
      [{ type: 'text', text: 'Run it' }]
    );
    const started: CodexEvent = {
      sequence: 1,
      kind: 'turnStarted',
      method: 'turn/started',
      threadId: 'thread-1',
      turnId: 'turn-9'
    };
    const bound = reconcilePendingSubmissions({ 'thread-1': [pending] }, started);
    expect(bound['thread-1'][0].turnId).toBe('turn-9');

    const completed = reconcilePendingSubmissions(bound, {
        ...started,
        sequence: 2,
        kind: 'turnCompleted',
        method: 'turn/completed'
    });
    expect(completed).toEqual(bound);
    expect(reconcilePendingSubmissions(completed, {
      ...itemEvent('thread-1', userMessage('client-1', 'Run it')),
      turnId: 'turn-9'
    })).toEqual({});
  });

  it('binds but preserves the prompt when a runtime omits turn/started', () => {
    const pending = createPendingSubmission(
      'thread-1',
      'client-1',
      'turn',
      [{ type: 'text', text: 'Fast request' }]
    );

    expect(
      reconcilePendingSubmissions(
        { 'thread-1': [pending] },
        {
          sequence: 2,
          kind: 'turnCompleted',
          method: 'turn/completed',
          threadId: 'thread-1',
          turnId: 'turn-fast'
        }
      )
    ).toEqual({ 'thread-1': [{ ...pending, turnId: 'turn-fast' }] });
  });

  it('preserves accepted steers when completion omits their user items', () => {
    const first = {
      ...createPendingSubmission('thread-1', 'client-1', 'steer', [
        { type: 'text', text: 'First steer' }
      ]),
      turnId: 'turn-1'
    };
    const second = {
      ...createPendingSubmission('thread-1', 'client-2', 'steer', [
        { type: 'text', text: 'Second steer' }
      ]),
      turnId: 'turn-1'
    };
    const accepted = acceptPendingSubmission(
      acceptPendingSubmission(
        { 'thread-1': [first, second] },
        'thread-1',
        'client-1',
        'turn-1'
      ),
      'thread-1',
      'client-2',
      'turn-1'
    );

    expect(
      reconcilePendingSubmissions(accepted, {
        sequence: 3,
        kind: 'turnCompleted',
        method: 'turn/completed',
        threadId: 'thread-1',
        turnId: 'turn-1'
      })
    ).toEqual(accepted);
  });

  it('does not discard earlier prompts when a later turn starts', () => {
    const pending = createPendingSubmission('thread-1', 'client-1', 'turn', [
      { type: 'text', text: 'Keep the first question' }
    ]);
    const accepted = acceptPendingSubmission(
      { 'thread-1': [pending] }, 'thread-1', 'client-1', 'turn-1'
    );
    expect(reconcilePendingSubmissions(accepted, {
      sequence: 2, kind: 'turnStarted', method: 'turn/started',
      threadId: 'thread-1', turnId: 'turn-2'
    })).toEqual(accepted);
  });

  it('matches repeated prompts against their own turn when history is loaded', () => {
    const pending = {
      ...createPendingSubmission('thread-1', 'client-2', 'turn', [
        { type: 'text', text: 'Same question' }
      ]),
      turnId: 'turn-2'
    };
    const oldTurn: CodexTurn = {
      id: 'turn-1', status: 'completed', itemsView: 'full',
      items: [userMessage(null, 'Same question')]
    };
    const history: CodexThread = {
      id: 'thread-1', sessionId: 'thread-1', title: 'History', preview: '',
      cwd: '/tmp/project', modelProvider: 'openai', createdAt: 1, updatedAt: 2,
      status: 'idle', source: 'appServer', cliVersion: '', archived: false,
      turns: [oldTurn]
    };
    expect(unacknowledgedSubmissions([pending], history)).toEqual([pending]);
    expect(reconcilePendingSubmissions({ 'thread-1': [pending] },
      itemEvent('thread-1', userMessage(null, 'Same question'))
    )).toEqual({ 'thread-1': [pending] });
    history.turns.push({ ...oldTurn, id: 'turn-2' });
    expect(unacknowledgedSubmissions([pending], history)).toEqual([]);
  });

  it('uses the direct turn/start response as the authoritative acknowledgement', () => {
    const pending = createPendingSubmission(
      'thread-1',
      'client-1',
      'turn',
      [{ type: 'text', text: 'Question' }]
    );
    const emptyTurn: CodexTurn = {
      id: 'turn-1',
      status: 'inProgress',
      items: [],
      itemsView: 'full'
    };
    const accepted = reconcileTurnStartResponse(
      { 'thread-1': [pending] },
      'thread-1',
      'client-1',
      emptyTurn
    );
    expect(accepted['thread-1'][0]).toMatchObject({
      status: 'accepted',
      turnId: 'turn-1'
    });

    expect(
      reconcileTurnStartResponse(
        accepted,
        'thread-1',
        'client-1',
        {
          ...emptyTurn,
          items: [userMessage('runtime-generated-id', 'Question')]
        }
      )
    ).toEqual({});
  });

  it('updates delivery state and removes acknowledged submissions', () => {
    const pending = createPendingSubmission(
      'thread-1',
      'client-1',
      'steer',
      [{ type: 'text', text: 'Continue' }]
    );
    const current = { 'thread-1': [pending] };
    const accepted = updatePendingSubmissionStatus(
      current,
      'thread-1',
      'client-1',
      'accepted'
    );
    expect(accepted['thread-1'][0].status).toBe('accepted');

    const failed = updatePendingSubmissionStatus(
      accepted,
      'thread-1',
      'client-1',
      'failed',
      'runtime disconnected'
    );
    expect(failed['thread-1'][0]).toMatchObject({
      status: 'failed',
      error: 'runtime disconnected'
    });
    expect(removePendingSubmission(failed, 'thread-1', 'client-1')).toEqual({});
  });
});
