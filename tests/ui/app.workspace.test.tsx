import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspaceOne = {
    id: 'ws-added',
    name: 'workspace-added',
    path: '/tmp/workspace-added',
    kind: 'local' as const,
    rdevSshCommand: null,
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceTwo = {
    id: 'ws-second',
    name: 'workspace-second',
    path: '/tmp/workspace-second',
    kind: 'local' as const,
    rdevSshCommand: null,
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceRdev = {
    id: 'ws-rdev',
    name: 'example-env',
    path: 'rdev-workspace-1',
    kind: 'rdev' as const,
    rdevSshCommand: 'rdev ssh team/example-env',
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceSsh = {
    id: 'ws-ssh',
    name: 'remote-host',
    path: 'ssh-workspace-1',
    kind: 'ssh' as const,
    rdevSshCommand: null,
    sshCommand: 'ssh dev@remote-host',
    remotePath: '~/projects/example',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  type WorkspaceFixture = typeof workspaceOne | typeof workspaceRdev | typeof workspaceSsh;
  let workspaceState: WorkspaceFixture[] = [];

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
    listWorkspaces: vi.fn(async () => workspaceState),
    addWorkspace: vi.fn(async () => {
      workspaceState = [workspaceOne];
      return workspaceOne;
    }),
    addRdevWorkspace: vi.fn(async () => {
      workspaceState = [workspaceRdev];
      return workspaceRdev;
    }),
    addSshWorkspace: vi.fn(async () => {
      workspaceState = [workspaceSsh];
      return workspaceSsh;
    }),
    removeWorkspace: vi.fn(async (workspaceId: string) => {
      const before = workspaceState.length;
      workspaceState = workspaceState.filter((workspace) => workspace.id !== workspaceId);
      return workspaceState.length !== before;
    }),
    setWorkspaceOrder: vi.fn(async (workspaceIds: string[]) => {
      const byId = new Map(workspaceState.map((workspace) => [workspace.id, workspace]));
      const reordered = workspaceIds
        .map((workspaceId) => byId.get(workspaceId))
        .filter((workspace): workspace is WorkspaceFixture => Boolean(workspace));
      workspaceState = [...reordered, ...workspaceState.filter((workspace) => !workspaceIds.includes(workspace.id))];
      return workspaceState;
    }),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async (workspaceId: string, enabled: boolean) => {
      workspaceState = workspaceState.map((workspace) =>
        workspace.id === workspaceId
          ? { ...workspace, gitPullOnMasterForNewThreads: enabled, updatedAt: new Date().toISOString() }
          : workspace
      );
      return workspaceState.find((workspace) => workspace.id === workspaceId) ?? workspaceOne;
    }),
    getGitInfo: vi.fn(async () => null),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => []),
    createThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    renameThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    archiveThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    deleteThread: vi.fn(async () => true),
    setThreadFullAccess: vi.fn(async () => {
      throw new Error('not needed');
    }),
    clearThreadClaudeSession: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadClaudeSessionId: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadSkills: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    appendUserMessage: vi.fn(async () => {
      throw new Error('not needed');
    }),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    buildContextPreview: vi.fn(async () => ({ files: [], totalSize: 0, contextText: '' })),
    getSettings: vi.fn(async () => ({ claudeCliPath: '/usr/local/bin/claude' })),
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
      thread: {
        id: 'thread-1',
        workspaceId: 'ws-added',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: 'New thread',
        isArchived: false,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
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
    openTerminalCommand: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
    discoverImportableClaudeSessions: vi.fn(async () => []),
    getImportableClaudeSession: vi.fn(async () => null),
    writeTextToClipboard: vi.fn(async () => undefined)
  };
  const openDialog = vi.fn(async () => null);
  const confirmDialog = vi.fn(async () => true);
  const helperMocks = {
    sendTaskCompletionAlert: vi.fn(async () => true),
    sendTaskCompletionAlertsEnabledConfirmation: vi.fn(async () => true),
    sendTaskCompletionAlertsTestNotification: vi.fn(async () => true)
  };

  const reset = () => {
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
    openDialog.mockClear();
    confirmDialog.mockClear();
    Object.values(helperMocks).forEach((fn) => {
      fn.mockClear();
    });
    workspaceState = [];
  };

  return {
    api,
    reset,
    ...helperMocks,
    seedWorkspaces: (next: Array<typeof workspaceOne>) => {
      workspaceState = next.map((workspace) => ({ ...workspace }));
    },
    sampleWorkspaces: {
      workspaceOne,
      workspaceTwo,
      workspaceRdev,
      workspaceSsh
    },
    openDialog,
    confirmDialog,
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async () => () => undefined),
    onTerminalReady: vi.fn(async () => () => undefined),
    onTerminalSshAuthStatus: vi.fn(async () => () => undefined),
    onTerminalTurnCompleted: vi.fn(async () => () => undefined),
    onTerminalExit: vi.fn(async () => () => undefined),
    onThreadUpdated: vi.fn(async () => () => undefined)
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
  sendTaskCompletionAlert: mocks.sendTaskCompletionAlert,
  sendTaskCompletionAlertsEnabledConfirmation: mocks.sendTaskCompletionAlertsEnabledConfirmation,
  sendTaskCompletionAlertsTestNotification: mocks.sendTaskCompletionAlertsTestNotification
}));

import App from '../../src/App';

function createDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? ''
  } as unknown as DataTransfer;
}

function getWorkspaceOrder(): string[] {
  return Array.from(document.querySelectorAll('.workspace-group .workspace-group-name'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter((value) => value.length > 0);
}

describe('Workspace add flow', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('does nothing when native directory selection is canceled', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));

    expect(mocks.api.addWorkspace).not.toHaveBeenCalled();
  });

  it('adds workspace from manual fallback modal and updates UI immediately', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));

    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    expect(mocks.api.addWorkspace).toHaveBeenCalledWith('/tmp/workspace-added');
    expect(await screen.findByRole('button', { name: /workspace-added/i })).toBeInTheDocument();
  });

  it('removes workspace from the workspace context menu', async () => {
    const user = userEvent.setup();
    mocks.confirmDialog.mockResolvedValueOnce(true);
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    await screen.findByRole('button', { name: /workspace-added/i });

    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.api.removeWorkspace).toHaveBeenCalledWith('ws-added');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /workspace-added/i })).not.toBeInTheDocument();
    });
  });

  it('does not remove workspace when remove confirmation is canceled', async () => {
    const user = userEvent.setup();
    mocks.confirmDialog.mockResolvedValueOnce(false);
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    await screen.findByRole('button', { name: /workspace-added/i });

    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.api.removeWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /workspace-added/i })).toBeInTheDocument();
  });

  it('does not reorder workspaces by drag-and-drop when drag is disabled', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    const sourceRow = screen.getByRole('button', { name: /workspace-added/i }).closest('.workspace-group-row');
    const targetGroup = screen.getByRole('button', { name: /workspace-second/i }).closest('.workspace-group');
    expect(sourceRow).not.toBeNull();
    expect(targetGroup).not.toBeNull();

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(sourceRow as HTMLElement, { dataTransfer });
    fireEvent.dragOver(targetGroup as HTMLElement, { dataTransfer });
    fireEvent.drop(targetGroup as HTMLElement, { dataTransfer });
    fireEvent.dragEnd(sourceRow as HTMLElement, { dataTransfer });

    expect(mocks.api.setWorkspaceOrder).not.toHaveBeenCalled();
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);
  });

  it('reorders workspaces with move arrows when drag events are unavailable', async () => {
    const user = userEvent.setup();
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    const moveUpFirst = screen.queryByTestId('workspace-move-up-ws-added');
    const moveDownFirst = screen.getByTestId('workspace-move-down-ws-added');
    const moveDownLast = screen.queryByTestId('workspace-move-down-ws-second');
    expect(moveUpFirst).toBeNull();
    expect(moveDownLast).toBeNull();

    fireEvent.click(moveDownFirst);

    await waitFor(() => {
      expect(mocks.api.setWorkspaceOrder).toHaveBeenCalledWith(['ws-second', 'ws-added']);
    });
    await waitFor(() => {
      expect(getWorkspaceOrder()).toEqual(['workspace-second', 'workspace-added']);
    });
    expect(screen.queryByTestId('workspace-move-down-ws-added')).toBeNull();
    expect(screen.getByTestId('workspace-move-up-ws-added')).toBeInTheDocument();
  });

  it('adds an ssh workspace from the add-project modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(screen.getByRole('tab', { name: 'ssh' }));
    const modal = screen.getByText('Add Project').closest('section');
    expect(
      screen.getByText('Paste an ssh command that authenticates with an SSH key. ATController does not store credentials.')
    ).toBeInTheDocument();
    expect(modal?.textContent).toContain('Unlock your key with macOS Keychain or ssh-agent');
    expect(modal?.textContent).toContain('Recommended ~/.ssh/config: AddKeysToAgent yes UseKeychain yes');
    await user.type(screen.getByLabelText('ssh command'), 'ssh dev@remote-host');
    await user.type(screen.getByLabelText('Display name (optional)'), 'remote-host');
    await user.type(screen.getByLabelText('Remote path (optional)'), '~/projects/example');
    await user.click(screen.getByRole('button', { name: 'Add SSH project' }));

    expect(mocks.api.addSshWorkspace).toHaveBeenCalledWith(
      'ssh dev@remote-host',
      'remote-host',
      '~/projects/example'
    );
    expect(await screen.findByRole('button', { name: /remote-host/i })).toBeInTheDocument();
  });

  it('adds an rdev workspace from the add-project modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(screen.getByRole('tab', { name: 'rdev' }));
    await user.type(screen.getByLabelText('rdev ssh command'), 'rdev ssh team/example-env');
    await user.type(screen.getByLabelText('Display name (optional)'), 'example-env');
    await user.click(screen.getByRole('button', { name: 'Add rdev project' }));

    expect(mocks.api.addRdevWorkspace).toHaveBeenCalledWith('rdev ssh team/example-env', 'example-env');
    expect(await screen.findByRole('button', { name: /example-env/i })).toBeInTheDocument();
  });

  it('copies terminal diagnostics through the native clipboard bridge for a selected local workspace', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    const diagnosticsButton = await screen.findByRole('button', { name: 'Copy terminal env diagnostics' });
    expect(diagnosticsButton).toBeEnabled();

    await user.click(diagnosticsButton);

    await waitFor(() => {
      expect(mocks.api.copyTerminalEnvDiagnostics).toHaveBeenCalledWith('/tmp/workspace-added');
      expect(mocks.api.writeTextToClipboard).toHaveBeenCalledWith('diagnostics');
    });
  });

  it('closes settings on Escape', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    await screen.findByRole('button', { name: 'Copy terminal env diagnostics' });
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Copy terminal env diagnostics' })).not.toBeInTheDocument();
    });
  });

  it('sends a test alert from Settings when task completion alerts are enabled', async () => {
    const user = userEvent.setup();
    mocks.api.getSettings.mockResolvedValueOnce({
      claudeCliPath: '/usr/local/bin/claude',
      taskCompletionAlerts: true
    });

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const testAlertButton = await screen.findByRole('button', { name: 'Send test alert' });
    expect(testAlertButton).toBeEnabled();

    await user.click(testAlertButton);

    await waitFor(() => {
      expect(mocks.sendTaskCompletionAlertsTestNotification).toHaveBeenCalledTimes(1);
    });
  });

  it('imports a Claude session into a new thread from workspace menu', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });

    const createdThread = {
      id: 'thread-import',
      workspaceId: 'ws-added',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'New thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    };
    const importedThread = {
      ...createdThread,
      claudeSessionId: '123e4567-e89b-12d3-a456-426614174000'
    };

    mocks.api.createThread.mockResolvedValueOnce(createdThread);
    mocks.api.setThreadClaudeSessionId.mockResolvedValueOnce(importedThread);

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Import session…' }));
    await user.type(
      await screen.findByLabelText('Claude session ID'),
      '123e4567-e89b-12d3-a456-426614174000'
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(mocks.api.validateImportableClaudeSession).toHaveBeenCalledWith(
        '/tmp/workspace-added',
        '123e4567-e89b-12d3-a456-426614174000'
      );
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-added', 'claude-code', false);
      expect(mocks.api.setThreadClaudeSessionId).toHaveBeenCalledWith(
        'ws-added',
        'thread-import',
        '123e4567-e89b-12d3-a456-426614174000'
      );
    });

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-import' })
      );
    });

    const setCallOrder = mocks.api.setThreadClaudeSessionId.mock.invocationCallOrder[0] ?? 0;
    const startCallOrder = mocks.api.terminalStartSession.mock.invocationCallOrder.find(
      (value: number) => value > 0
    ) ?? 0;
    const validateCallOrder = mocks.api.validateImportableClaudeSession.mock.invocationCallOrder[0] ?? 0;
    expect(validateCallOrder).toBeGreaterThan(0);
    expect(validateCallOrder).toBeLessThan(setCallOrder);
    expect(setCallOrder).toBeGreaterThan(0);
    expect(startCallOrder).toBeGreaterThan(0);
    expect(setCallOrder).toBeLessThan(startCallOrder);
  });

  it('blocks importing a Claude session that belongs to a different local workspace', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });

    mocks.api.validateImportableClaudeSession.mockRejectedValueOnce(
      new Error('This Claude session belongs to a different workspace.')
    );

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Import session…' }));
    await user.type(
      await screen.findByLabelText('Claude session ID'),
      '123e4567-e89b-12d3-a456-426614174000'
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(
      await screen.findByText(/this claude session belongs to a different workspace/i)
    ).toBeInTheDocument();
    expect(mocks.api.createThread).not.toHaveBeenCalled();
    expect(mocks.api.setThreadClaudeSessionId).not.toHaveBeenCalled();
    expect(mocks.api.terminalStartSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-import' })
    );
  });

  it('bulk imports selected Claude sessions from Add Project and adds missing projects first', async () => {
    const user = userEvent.setup();
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne]);
    mocks.api.discoverImportableClaudeSessions.mockResolvedValueOnce([
      {
        path: '/tmp/workspace-added',
        name: 'workspace-added',
        pathExists: true,
        workspaceId: 'ws-added',
        workspaceName: 'workspace-added',
        sessions: [
          {
            sessionId: '11111111-1111-1111-1111-111111111111',
            summary: 'Existing project session',
            firstPrompt: 'resume existing work',
            messageCount: 6,
            createdAt: '2026-03-10T10:00:00.000Z',
            modifiedAt: '2026-03-10T11:00:00.000Z',
            gitBranch: 'feature/existing'
          }
        ]
      },
      {
        path: '/tmp/workspace-second',
        name: 'workspace-second',
        pathExists: true,
        workspaceId: null,
        workspaceName: null,
        sessions: [
          {
            sessionId: '22222222-2222-2222-2222-222222222222',
            summary: 'New project session',
            firstPrompt: 'resume new work',
            messageCount: 3,
            createdAt: '2026-03-11T10:00:00.000Z',
            modifiedAt: '2026-03-11T12:00:00.000Z',
            gitBranch: 'feature/new'
          }
        ]
      }
    ]);

    mocks.api.addWorkspace.mockImplementationOnce(async (path: string) => {
      expect(path).toBe('/tmp/workspace-second');
      mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
      return mocks.sampleWorkspaces.workspaceTwo;
    });

    const importedExistingThread = {
      id: 'thread-bulk-existing',
      workspaceId: 'ws-added',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'New thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: '11111111-1111-1111-1111-111111111111',
      lastResumeAt: null,
      lastNewSessionAt: null
    };
    const importedNewProjectThread = {
      ...importedExistingThread,
      id: 'thread-bulk-new',
      workspaceId: 'ws-second',
      claudeSessionId: '22222222-2222-2222-2222-222222222222'
    };

    mocks.api.createThread
      .mockResolvedValueOnce({
        ...importedExistingThread,
        id: 'thread-bulk-existing',
        claudeSessionId: null
      })
      .mockResolvedValueOnce({
        ...importedNewProjectThread,
        id: 'thread-bulk-new',
        claudeSessionId: null
      });
    mocks.api.setThreadClaudeSessionId
      .mockResolvedValueOnce(importedExistingThread)
      .mockResolvedValueOnce(importedNewProjectThread);

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(await screen.findByRole('button', { name: 'Import Claude sessions' }));

    await screen.findByRole('dialog', { name: 'Bulk Import Claude Sessions' });
    await user.click(screen.getByRole('checkbox', { name: /Existing project session/i }));
    await user.click(screen.getByRole('checkbox', { name: /New project session/i }));
    await user.click(screen.getByRole('button', { name: 'Import selected (2)' }));

    await waitFor(() => {
      expect(mocks.api.validateImportableClaudeSession).toHaveBeenCalledWith(
        '/tmp/workspace-added',
        '11111111-1111-1111-1111-111111111111'
      );
      expect(mocks.api.validateImportableClaudeSession).toHaveBeenCalledWith(
        '/tmp/workspace-second',
        '22222222-2222-2222-2222-222222222222'
      );
      expect(mocks.api.addWorkspace).toHaveBeenCalledWith('/tmp/workspace-second');
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-added', 'claude-code', false);
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-second', 'claude-code', false);
      expect(mocks.api.setThreadClaudeSessionId).toHaveBeenCalledWith(
        'ws-added',
        'thread-bulk-existing',
        '11111111-1111-1111-1111-111111111111'
      );
      expect(mocks.api.setThreadClaudeSessionId).toHaveBeenCalledWith(
        'ws-second',
        'thread-bulk-new',
        '22222222-2222-2222-2222-222222222222'
      );
    });

    expect(mocks.api.terminalStartSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-bulk-existing' })
    );
    expect(mocks.api.terminalStartSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-bulk-new' })
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Bulk Import Claude Sessions' })).not.toBeInTheDocument();
    });
  });
  it('reoffers an archived imported Claude session in bulk import so it can be recovered', async () => {
    const user = userEvent.setup();
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne]);
    mocks.api.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-archived-import',
        workspaceId: 'ws-added',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: 'Archived import',
        isArchived: true,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: '11111111-1111-1111-1111-111111111111',
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    ]);
    mocks.api.discoverImportableClaudeSessions.mockResolvedValueOnce([
      {
        path: '/tmp/workspace-added',
        name: 'workspace-added',
        pathExists: true,
        workspaceId: 'ws-added',
        workspaceName: 'workspace-added',
        sessions: [
          {
            sessionId: '11111111-1111-1111-1111-111111111111',
            summary: 'Recovered session',
            firstPrompt: 'recover me please',
            messageCount: 6,
            createdAt: '2026-03-10T10:00:00.000Z',
            modifiedAt: '2026-03-10T11:00:00.000Z',
            gitBranch: 'feature/recover'
          }
        ]
      }
    ]);

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(await screen.findByRole('button', { name: 'Import Claude sessions' }));

    await screen.findByRole('dialog', { name: 'Bulk Import Claude Sessions' });
    expect(await screen.findByRole('checkbox', { name: /Recovered session/i })).toBeInTheDocument();
    expect(screen.queryByText(/already imported/i)).not.toBeInTheDocument();
  });

});
