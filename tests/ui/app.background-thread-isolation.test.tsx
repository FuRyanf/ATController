import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    kind: 'local' as const,
    path: '/tmp/workspace',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const baseThreads = [
    {
      id: 'thread-a',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'Thread A',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    },
    {
      id: 'thread-b',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      title: 'Thread B',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    }
  ];

  let threadState = baseThreads.map((thread) => ({ ...thread }));
  let terminalDataHandler: ((event: { sessionId: string; data: string; startPosition: number; endPosition: number }) => void) | null = null;
  const terminalPositions = new Map<string, number>();

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => workspace),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }]),
    gitWorkspaceStatus: vi.fn(async () => ({ isDirty: false, uncommittedFiles: 0, insertions: 0, deletions: 0 })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitCreateAndCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(async () => ({ outcome: 'pulled' as const, message: 'ok' })),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => { throw new Error('not needed'); }),
    renameThread: vi.fn(async (_workspaceId: string, threadId: string, title: string) => {
      const updated = { ...threadState.find((thread) => thread.id === threadId)!, title };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    archiveThread: vi.fn(async () => true),
    deleteThread: vi.fn(async () => true),
    setThreadFullAccess: vi.fn(async () => { throw new Error('not needed'); }),
    clearThreadClaudeSession: vi.fn(async () => { throw new Error('not needed'); }),
    setThreadSkills: vi.fn(async () => { throw new Error('not needed'); }),
    setThreadAgent: vi.fn(async () => { throw new Error('not needed'); }),
    appendUserMessage: vi.fn(async () => { throw new Error('not needed'); }),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    buildContextPreview: vi.fn(async () => ({ files: [], totalSize: 0, contextText: '' })),
    getSettings: vi.fn(async () => ({ claudeCliPath: '/usr/local/bin/claude' })),
    saveSettings: vi.fn(async (settings: { claudeCliPath: string | null }) => settings),
    detectClaudeCliPath: vi.fn(async () => '/usr/local/bin/claude'),
    checkForUpdate: vi.fn(async () => ({ currentVersion: '0.1.12', latestVersion: '0.1.12', updateAvailable: false, releaseUrl: null })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(async (params: { threadId: string }) => ({
      sessionId: `session-${params.threadId}`,
      sessionMode: 'new',
      resumeSessionId: null,
      thread: threadState.find((thread) => thread.id === params.threadId) ?? threadState[0]
    })),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    terminalReadOutput: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const reset = () => {
    threadState = baseThreads.map((thread) => ({ ...thread }));
    terminalDataHandler = null;
    terminalPositions.clear();
    window.localStorage.clear();
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    emitTerminalData: (event: { sessionId: string; data: string }) => {
      const startPosition = terminalPositions.get(event.sessionId) ?? 0;
      const endPosition = startPosition + event.data.length;
      terminalPositions.set(event.sessionId, endPosition);
      terminalDataHandler?.({ ...event, startPosition, endPosition });
    },
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async (handler: (event: {
      sessionId: string;
      data: string;
      startPosition: number;
      endPosition: number;
    }) => void) => {
      terminalDataHandler = handler;
      return () => {
        if (terminalDataHandler === handler) {
          terminalDataHandler = null;
        }
      };
    }),
    onTerminalReady: vi.fn(async () => () => undefined),
    onTerminalSshAuthStatus: vi.fn(async () => () => undefined),
    onTerminalTurnCompleted: vi.fn(async () => () => undefined),
    onTerminalExit: vi.fn(async () => () => undefined),
    onThreadUpdated: vi.fn(async () => () => undefined),
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true)
  };
});

vi.mock('../../src/lib/api', () => ({
  api: mocks.api,
  onRunStream: mocks.onRunStream,
  onRunExit: mocks.onRunExit,
  onTerminalData: mocks.onTerminalData,
  onTerminalReady: mocks.onTerminalReady,
  onTerminalSshAuthStatus: mocks.onTerminalSshAuthStatus,
  onTerminalTurnCompleted: mocks.onTerminalTurnCompleted,
  onTerminalExit: mocks.onTerminalExit,
  onThreadUpdated: mocks.onThreadUpdated
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.openDialog,
  confirm: mocks.confirmDialog
}));

vi.mock('../../src/lib/taskCompletionAlerts', () => ({
  sendTaskCompletionAlert: vi.fn(async () => true),
  sendTaskCompletionAlertsEnabledConfirmation: vi.fn(async () => true),
  sendTaskCompletionAlertsTestNotification: vi.fn(async () => true)
}));

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: () => <section data-testid="terminal-panel-mock">terminal</section>
}));

import App from '../../src/App';

describe('background thread rendering isolation', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('does not re-render the left rail when only the selected thread stream updates', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Thread B/i });
    const sidebar = screen.getByTestId('sidebar');
    const initialCount = Number(sidebar.getAttribute('data-render-count') ?? '0');
    expect(initialCount).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /Thread A/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-a' }));
    });

    const beforeSelectedOutput = Number(sidebar.getAttribute('data-render-count') ?? '0');

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-a', data: 'selected output\n' });
    });

    await waitFor(() => {
      expect(Number(sidebar.getAttribute('data-render-count') ?? '0')).toBe(beforeSelectedOutput);
    });
  });
});
