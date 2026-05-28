import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LeftRail } from '../../src/components/LeftRail';
import type { ThreadMetadata, Workspace } from '../../src/types';

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
    title: 'Copilot thread',
    createdAt,
    updatedAt: createdAt,
    isArchived: false,
    lastRunStatus: 'Idle',
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    agentId: 'github-copilot',
    fullAccess: false,
    enabledSkills: [],
    claudeSessionId: null,
    copilotSessionId: null,
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
    agentLabel: 'Copilot',
    elevatedAccessLabel: 'Autopilot',
    showImportSession: false,
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

describe('LeftRail provider labels', () => {
  it('shows Copilot new-thread labels and hides Claude import actions', async () => {
    const user = userEvent.setup();
    const props = renderLeftRail();

    const newThreadButton = screen.getByTestId('workspace-new-thread-ws-1');
    expect(newThreadButton).toHaveTextContent('New Copilot thread');

    await user.click(newThreadButton);
    await waitFor(() => {
      expect(props.onNewThreadInWorkspace).toHaveBeenCalledWith('ws-1', { fullAccess: false });
    });

    await user.click(screen.getByTestId('workspace-new-thread-options-ws-1'));
    expect(await screen.findByRole('button', { name: 'Copilot thread' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copilot autopilot thread' }));

    await waitFor(() => {
      expect(props.onNewThreadInWorkspace).toHaveBeenCalledWith('ws-1', { fullAccess: true });
    });

    await user.click(screen.getByRole('button', { name: 'Workspace actions' }));
    expect(screen.queryByRole('button', { name: /Import session/i })).not.toBeInTheDocument();
  });

  it('enables resume actions from Copilot session IDs', async () => {
    const user = userEvent.setup();
    const copilotThread = thread({ copilotSessionId: 'copilot-session-1' });
    const props = renderLeftRail({
      threadsByWorkspace: { 'ws-1': [copilotThread] }
    });

    const row = screen.getByText('Copilot thread').closest('[data-thread-id="thread-1"]');
    expect(row).not.toBeNull();

    fireEvent.contextMenu(row as Element, { clientX: 100, clientY: 100 });
    await user.click(await screen.findByRole('button', { name: 'Copy resume command' }));

    expect(props.onCopyResumeCommand).toHaveBeenCalledWith(copilotThread);
  });
});
