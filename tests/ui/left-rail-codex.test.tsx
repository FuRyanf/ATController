import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LeftRail } from '../../src/components/LeftRail';
import type { RecentCodexThread, ThreadMetadata, Workspace } from '../../src/types';

const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();

const workspace: Workspace = {
  id: 'ws-1',
  name: 'Workspace',
  path: '/tmp/workspace',
  kind: 'local',
  rdevSshCommand: null,
  sshCommand: null,
  gitPullOnMasterForNewThreads: false,
  createdAt,
  updatedAt: createdAt
};

function thread(overrides: Partial<ThreadMetadata> = {}): ThreadMetadata {
  return {
    id: 'thread-1',
    workspaceId: 'ws-1',
    title: 'Codex thread',
    createdAt,
    updatedAt: createdAt,
    isArchived: false,
    lastRunStatus: 'Idle',
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    fullAccess: false,
    enabledSkills: [],
    codexSessionId: null,
    ...overrides
  };
}

function renderLeftRail(overrides: Partial<ComponentProps<typeof LeftRail>> = {}) {
  const props: ComponentProps<typeof LeftRail> = {
    sidebarWidth: 320,
    workspaces: [workspace],
    threadsByWorkspace: { 'ws-1': [thread()] },
    selectedWorkspaceId: 'ws-1',
    selectedThreadId: 'thread-1',
    threadSearch: '',
    getThreadDisplayTimestampMs: () => Date.parse(createdAt),
    onOpenWorkspacePicker: vi.fn(),
    onOpenSettings: vi.fn(),
    onNewThreadInWorkspace: vi.fn(async () => undefined),
    onThreadSearchChange: vi.fn(),
    onSelectThread: vi.fn(),
    onRenameThread: vi.fn(async () => undefined),
    onDeleteThread: vi.fn(async () => undefined),
    onOpenWorkspaceInFinder: vi.fn(),
    onOpenWorkspaceInTerminal: vi.fn(),
    onSetWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => undefined),
    onReorderWorkspaces: vi.fn(async () => undefined),
    onRemoveWorkspace: vi.fn(async () => undefined),
    onCopyResumeCommand: vi.fn(),
    onOpenResumeCommandInTerminal: vi.fn(),
    onCopyWorkspaceCommand: vi.fn(),
    onImportSession: vi.fn(),
    ...overrides
  };
  render(<LeftRail {...props} />);
  return props;
}

describe('LeftRail Codex actions', () => {
  it('shows Codex new-thread labels and Codex import actions', async () => {
    const user = userEvent.setup();
    const props = renderLeftRail();

    const newThreadButton = screen.getByTestId('workspace-new-thread-ws-1');
    expect(newThreadButton).toHaveTextContent('New Codex thread');

    await user.click(newThreadButton);
    await waitFor(() => {
      expect(props.onNewThreadInWorkspace).toHaveBeenCalledWith('ws-1', { fullAccess: false });
    });

    await user.click(screen.getByTestId('workspace-new-thread-options-ws-1'));
    expect(await screen.findByRole('button', { name: 'Codex thread' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Codex full access thread' }));

    await waitFor(() => {
      expect(props.onNewThreadInWorkspace).toHaveBeenCalledWith('ws-1', { fullAccess: true });
    });

    await user.click(screen.getByRole('button', { name: 'Workspace actions' }));
    expect(screen.getByRole('button', { name: 'Import Codex session…' })).toBeInTheDocument();
  });

  it('enables resume actions from Codex session IDs', async () => {
    const user = userEvent.setup();
    const codexThread = thread({ codexSessionId: 'codex-session-1' });
    const props = renderLeftRail({
      threadsByWorkspace: { 'ws-1': [codexThread] }
    });

    const row = screen.getByText('Codex thread').closest('[data-thread-id="thread-1"]');
    expect(row).not.toBeNull();

    fireEvent.contextMenu(row as Element, { clientX: 100, clientY: 100 });
    await user.click(await screen.findByRole('button', { name: 'Copy resume command' }));

    expect(props.onCopyResumeCommand).toHaveBeenCalledWith(codexThread);
  });

  it('orders recent Codex history with live threads and excludes archived storage', async () => {
    const user = userEvent.setup();
    const olderThread = thread({
      id: 'older-thread',
      title: 'Older stored thread',
      codexSessionId: 'stored-session',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const archivedThread = thread({
      id: 'archived-thread',
      title: 'Archived stored thread',
      codexSessionId: 'archived-session',
      isArchived: true,
      updatedAt: '2026-01-04T00:00:00.000Z'
    });
    const recentThread: RecentCodexThread = {
      sessionId: 'unimported-recent-session',
      workspaceId: workspace.id,
      title: 'Recent Codex session',
      createdAt: Date.parse('2026-01-02T00:00:00.000Z') / 1000,
      updatedAt: Date.parse('2026-01-03T00:00:00.000Z') / 1000,
      recencyAt: Date.parse('2026-01-03T12:00:00.000Z') / 1000
    };
    const onOpenRecentCodexThread = vi.fn(async () => undefined);
    renderLeftRail({
      threadsByWorkspace: {
        'ws-1': [archivedThread, olderThread]
      },
      recentCodexThreadsByWorkspace: {
        'ws-1': [recentThread]
      },
      getThreadDisplayTimestampMs: (candidate) => Date.parse(candidate.updatedAt),
      onOpenRecentCodexThread
    });

    const recentRow = screen
      .getByText('Recent Codex session')
      .closest('[data-codex-session-id="unimported-recent-session"]');
    const olderRow = screen
      .getByText('Older stored thread')
      .closest('[data-thread-id="older-thread"]');
    expect(recentRow).not.toBeNull();
    expect(olderRow).not.toBeNull();
    expect(recentRow?.nextElementSibling).toBe(olderRow);
    expect(screen.queryByText('Archived stored thread')).not.toBeInTheDocument();

    await user.click(screen.getByTitle('Open Codex thread: Recent Codex session'));

    expect(onOpenRecentCodexThread).toHaveBeenCalledTimes(1);
    expect(onOpenRecentCodexThread).toHaveBeenCalledWith(workspace, recentThread);
  });
});
