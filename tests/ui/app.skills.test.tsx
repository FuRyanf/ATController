import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MULTILINE_ENTER_SEQUENCE = '\x1b\r';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    kind: 'local' as const,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const baseThread = {
    id: 'thread-1',
    workspaceId: 'ws-1',
    agentId: 'claude-code',
    fullAccess: false,
    enabledSkills: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'Use project skills',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: null,
    lastResumeAt: null,
    lastNewSessionAt: null
  };

  let threadState = [{ ...baseThread }];

  const skills = [
    {
      id: 'review',
      name: 'Review',
      description: 'Review changes before shipping them.',
      entryPoints: ['/skill review'],
      path: '/tmp/workspace/.claude/skills/review',
      relativePath: '.claude/skills/review/SKILL.md',
      warning: null
    },
    {
      id: 'refactor',
      name: 'Refactor',
      description: 'Refactor carefully and keep behavior stable.',
      entryPoints: ['/skill refactor'],
      path: '/tmp/workspace/.claude/skills/refactor',
      relativePath: '.claude/skills/refactor/SKILL.md',
      warning: null
    }
  ];

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/Claudex'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    addSshWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceOrder: vi.fn(async () => [workspace]),
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
    gitWorkspaceStatus: vi.fn(async () => ({
      isDirty: false,
      uncommittedFiles: 0,
      insertions: 0,
      deletions: 0
    })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitCreateAndCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    renameThread: vi.fn(async (_workspaceId: string, threadId: string, title: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        title,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    archiveThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    deleteThread: vi.fn(async () => true),
    setThreadFullAccess: vi.fn(async (_workspaceId: string, threadId: string, fullAccess: boolean) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        fullAccess,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    clearThreadClaudeSession: vi.fn(async () => threadState[0]),
    setThreadSkills: vi.fn(async (_workspaceId: string, threadId: string, enabledSkills: string[]) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        enabledSkills,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    setThreadAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    appendUserMessage: vi.fn(async () => {
      throw new Error('not needed');
    }),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => skills),
    buildContextPreview: vi.fn(async () => ({ files: [], totalSize: 0, contextText: '' })),
    getSettings: vi.fn(async () => ({ claudeCliPath: '/usr/local/bin/claude', appearanceMode: 'dark' })),
    saveSettings: vi.fn(async (settings: { claudeCliPath: string | null }) => settings),
    detectClaudeCliPath: vi.fn(async () => '/usr/local/bin/claude'),
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.12',
      latestVersion: '0.1.12',
      updateAvailable: false,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(async () => ({
      sessionId: 'session-1',
      sessionMode: 'new',
      resumeSessionId: null,
      thread: threadState[0]
    })),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    terminalReadOutput: vi.fn(async () => ({
      text: '? for shortcuts',
      startPosition: 0,
      endPosition: '? for shortcuts'.length,
      truncated: false
    })),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    openExternalUrl: vi.fn(async () => undefined),
    openTerminalCommand: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const reset = () => {
    threadState = [{ ...baseThread }];
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
    currentThread: () => threadState[0],
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async () => () => undefined),
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

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: ({ onData }: { onData?: (data: string) => void }) => (
    <section data-testid="terminal-panel-mock">
      <button type="button" onClick={() => onData?.('hey')}>
        Type prompt
      </button>
      <button type="button" onClick={() => onData?.(MULTILINE_ENTER_SEQUENCE)}>
        Shift Enter
      </button>
      <button type="button" onClick={() => onData?.('ship it\r')}>
        Submit prompt
      </button>
    </section>
  )
}));

import App from '../../src/App';

describe('Skills management', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('discovers repo skills and persists thread selection from the skills popover', async () => {
    const user = userEvent.setup();
    render(<App />);

    const skillsButton = await screen.findByRole('button', { name: /^skills$/i });
    await user.click(skillsButton);

    expect(await screen.findByText('Review')).toBeInTheDocument();
    expect(screen.getByText('.claude/skills/review/SKILL.md')).toBeInTheDocument();

    await user.click(screen.getByText('Review').closest('button')!);

    await waitFor(() => {
      expect(mocks.api.setThreadSkills).toHaveBeenCalledWith('ws-1', 'thread-1', ['review']);
    });

    expect(
      screen.getByText(/selected skills are prepended off-screen before claude receives your next submitted prompt/i)
    ).toBeInTheDocument();
  });

  it('autofocuses the search field and filters the visible skills list in real time', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /^skills$/i }));

    const searchInput = await screen.findByRole('searchbox', { name: 'Search skills' });
    await waitFor(() => {
      expect(searchInput).toHaveFocus();
    });

    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Refactor')).toBeInTheDocument();

    await user.type(searchInput, 'refactor stable');

    expect(screen.getByText('Refactor')).toBeInTheDocument();
    expect(screen.queryByText('Review')).not.toBeInTheDocument();

    await user.clear(searchInput);

    expect(await screen.findByText('Review')).toBeInTheDocument();
  });

  it('keeps skill selection working while the list is filtered', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /^skills$/i }));

    const searchInput = await screen.findByRole('searchbox', { name: 'Search skills' });
    await user.type(searchInput, 'review shipping');
    await user.click((await screen.findByText('Review')).closest('button')!);

    await waitFor(() => {
      expect(mocks.api.setThreadSkills).toHaveBeenCalledWith('ws-1', 'thread-1', ['review']);
    });
  });

  it('shows a no-match state when search excludes every skill', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /^skills$/i }));

    const searchInput = await screen.findByRole('searchbox', { name: 'Search skills' });
    await user.type(searchInput, 'totally missing');

    expect(screen.getByRole('status')).toHaveTextContent('No skills match "totally missing".');
  });

  it('injects selected skills invisibly into the next submitted terminal prompt', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mocks.api.listSkills).toHaveBeenCalledWith('/tmp/workspace');
    });

    await user.click(await screen.findByRole('button', { name: /^skills$/i }));
    await user.click((await screen.findByText('Review')).closest('button')!);

    await waitFor(() => {
      expect(mocks.api.setThreadSkills).toHaveBeenCalledWith('ws-1', 'thread-1', ['review']);
    });

    await user.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalled();
    });
    const terminalWriteCalls = mocks.api.terminalWrite.mock.calls;
    const lastPayload = terminalWriteCalls[terminalWriteCalls.length - 1]?.[1];
    expect(lastPayload).toContain('ship it');
    expect(lastPayload).toContain('Project skills to use for this request when relevant:');
    expect(lastPayload).toContain('Review (.claude/skills/review/SKILL.md)');
    expect(lastPayload.endsWith('\r')).toBe(true);

    await waitFor(() => {
      expect(mocks.api.setThreadSkills).toHaveBeenLastCalledWith('ws-1', 'thread-1', []);
    });
  });

  it('clears selected skills after a queued submit flushes when startup completes', async () => {
    let resolveStart:
      | ((value: {
          sessionId: string;
          sessionMode: 'new';
          resumeSessionId: null;
          thread: ReturnType<typeof mocks.currentThread>;
        }) => void)
      | null = null;
    mocks.api.terminalStartSession.mockImplementationOnce(
      async () =>
        await new Promise<{
          sessionId: string;
          sessionMode: 'new';
          resumeSessionId: null;
          thread: ReturnType<typeof mocks.currentThread>;
        }>((resolve) => {
          resolveStart = resolve;
        })
    );

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /^skills$/i }));
    await user.click((await screen.findByText('Review')).closest('button')!);

    await waitFor(() => {
      expect(mocks.api.setThreadSkills).toHaveBeenCalledWith('ws-1', 'thread-1', ['review']);
    });

    await user.click(screen.getByRole('button', { name: 'Submit prompt' }));
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();

    resolveStart?.({
      sessionId: 'session-1',
      sessionMode: 'new',
      resumeSessionId: null,
      thread: mocks.currentThread()
    });

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('Project skills to use for this request when relevant:')
      );
    });

    await waitFor(() => {
      expect(mocks.api.setThreadSkills).toHaveBeenLastCalledWith('ws-1', 'thread-1', []);
    });
  });

  it('does not inject selected skills on Shift+Enter before the real submit', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mocks.api.listSkills).toHaveBeenCalledWith('/tmp/workspace');
    });

    await user.click(await screen.findByRole('button', { name: /^skills$/i }));
    await user.click((await screen.findByText('Review')).closest('button')!);

    await waitFor(() => {
      expect(mocks.api.setThreadSkills).toHaveBeenCalledWith('ws-1', 'thread-1', ['review']);
    });

    await user.click(screen.getByRole('button', { name: 'Type prompt' }));
    await user.click(screen.getByRole('button', { name: 'Shift Enter' }));

    expect(mocks.api.renameThread).not.toHaveBeenCalled();
    const terminalPayloads = mocks.api.terminalWrite.mock.calls.map((call) => call[1]);
    expect(terminalPayloads).toContain('hey');
    expect(terminalPayloads).toContain(MULTILINE_ENTER_SEQUENCE);
    expect(
      terminalPayloads.some(
        (payload) => typeof payload === 'string' && payload.includes('Project skills to use for this request when relevant:')
      )
    ).toBe(false);
  });

  it('shows a calm empty state when the repo has no project skills', async () => {
    mocks.api.listSkills.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /^skills$/i }));

    expect(await screen.findByText(/No skills found\./i)).toBeInTheDocument();
    expect(screen.getByText(/\.claude\/skills\/review\/SKILL\.md/i)).toBeInTheDocument();
    expect(screen.getByText(/~\/\.claude\/skills\/review\/SKILL\.md/i)).toBeInTheDocument();
  });
});
