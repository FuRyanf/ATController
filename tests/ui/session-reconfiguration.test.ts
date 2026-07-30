import { describe, expect, it, vi } from 'vitest';

import {
  reinstantiateCodexThreadSession,
  requiresSessionReinstantiation
} from '../../src/lib/sessionReconfiguration';
import type {
  CodexThreadSession,
  ThreadPreferences
} from '../../src/types';

const preferences: ThreadPreferences = {
  permissionMode: 'workspaceAccess',
  model: 'runtime-model',
  reasoningEffort: 'high',
  serviceTier: 'standard'
};

const session: CodexThreadSession = {
  thread: {
    id: 'thread-1',
    sessionId: 'thread-1',
    title: 'Thread',
    preview: '',
    cwd: '/tmp/project',
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    status: 'idle',
    source: 'appServer',
    cliVersion: '0.144.0',
    archived: false,
    turns: []
  },
  settings: {
    requestedModel: 'runtime-model',
    effectiveModel: 'runtime-model',
    modelResolution: 'applied',
    requestedReasoningEffort: 'high',
    effectiveReasoningEffort: 'high',
    reasoningEffortResolution: 'applied',
    requestedServiceTier: 'standard',
    effectiveServiceTier: 'standard',
    serviceTierResolution: 'applied',
    permissionMode: 'workspaceAccess',
    permissionProfile: 'Workspace Access',
    approvalPolicy: 'on-request',
    sandboxPolicy: 'workspaceWrite',
    cwd: '/tmp/project'
  },
  instructionSources: []
};

describe('Codex thread session reconfiguration', () => {
  it('requires reinstantiation only for reasoning or access changes', () => {
    expect(
      requiresSessionReinstantiation(preferences, {
        ...preferences,
        serviceTier: 'priority'
      })
    ).toBe(false);
    expect(
      requiresSessionReinstantiation(preferences, {
        ...preferences,
        reasoningEffort: 'medium'
      })
    ).toBe(true);
    expect(
      requiresSessionReinstantiation(preferences, {
        ...preferences,
        permissionMode: 'fullAccess'
      })
    ).toBe(true);
  });

  it('interrupts an active turn before resuming the canonical thread', async () => {
    const calls: string[] = [];
    const client = {
      interruptCodexTurn: vi.fn(async () => {
        calls.push('interrupt');
      }),
      resumeCodexThread: vi.fn(async () => {
        calls.push('resume');
        return session;
      })
    };

    await expect(
      reinstantiateCodexThreadSession(client, {
        workspacePath: '/tmp/project',
        threadId: 'thread-1',
        activeTurnId: 'turn-1',
        preferences
      })
    ).resolves.toEqual({ session, interrupted: true });
    expect(calls).toEqual(['interrupt', 'resume']);
    expect(client.interruptCodexTurn).toHaveBeenCalledWith('thread-1', 'turn-1');
    expect(client.resumeCodexThread).toHaveBeenCalledWith(
      '/tmp/project',
      'thread-1',
      preferences
    );
  });

  it('resumes an idle thread without inventing or replaying a turn', async () => {
    const client = {
      interruptCodexTurn: vi.fn(async () => undefined),
      resumeCodexThread: vi.fn(async () => session)
    };

    await expect(
      reinstantiateCodexThreadSession(client, {
        workspacePath: '/tmp/project',
        threadId: 'thread-1',
        preferences
      })
    ).resolves.toEqual({ session, interrupted: false });
    expect(client.interruptCodexTurn).not.toHaveBeenCalled();
    expect(client.resumeCodexThread).toHaveBeenCalledOnce();
  });

  it('does not resume when an active turn could not be interrupted', async () => {
    const client = {
      interruptCodexTurn: vi.fn(async () => {
        throw new Error('interrupt failed');
      }),
      resumeCodexThread: vi.fn(async () => session)
    };

    await expect(
      reinstantiateCodexThreadSession(client, {
        workspacePath: '/tmp/project',
        threadId: 'thread-1',
        activeTurnId: 'turn-1',
        preferences
      })
    ).rejects.toThrow('interrupt failed');
    expect(client.resumeCodexThread).not.toHaveBeenCalled();
  });
});
