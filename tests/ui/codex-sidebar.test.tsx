import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CodexSidebar } from '../../src/components/CodexSidebar';
import type { CodexThread, CodexThreadUiMetadata, Workspace } from '../../src/types';

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Project',
  path: '/tmp/project',
  kind: 'local',
  gitPullOnMasterForNewThreads: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

function thread(id: string, archived = false): CodexThread {
  return {
    id,
    sessionId: id,
    title: archived ? 'Archived work' : 'Recent work',
    preview: 'Codex session',
    cwd: workspace.path,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: archived ? 1 : 2,
    status: 'idle',
    source: 'appServer',
    cliVersion: '0.144.0',
    archived,
    turns: []
  };
}

function metadata(threadId: string, pinned = false): CodexThreadUiMetadata {
  return {
    threadId,
    workspaceId: workspace.id,
    fallbackTitle: threadId,
    pinned,
    unread: false,
    draft: '',
    promptHistory: [],
    permissionMode: 'fullAccess',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  };
}

describe('Codex thread sidebar', () => {
  it('separates current app-server results from archived threads and never invents legacy rows', () => {
    render(
      <CodexSidebar
        workspaces={[workspace]}
        selectedWorkspaceId={workspace.id}
        selectedThreadId="active"
        threads={[thread('active'), thread('archived', true)]}
        metadata={{ active: metadata('active'), archived: metadata('archived') }}
        approvals={{}}
        filter=""
        connectionState="ready"
        collapsed={false}
        onSelectWorkspace={vi.fn()}
        onAddWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onSelectThread={vi.fn()}
        onRenameThread={vi.fn()}
        onOpenThreadMenu={vi.fn()}
        onFilterChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />
    );
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeInTheDocument();
    expect(screen.getByText('Recent work')).toBeInTheDocument();
    expect(screen.getByText('Archived work')).toBeInTheDocument();
    expect(screen.queryByText('Legacy imported session')).not.toBeInTheDocument();
  });

  it('opens, renames, and exposes the thread context menu from native interactions', async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    const onRenameThread = vi.fn();
    const onOpenThreadMenu = vi.fn();
    render(
      <CodexSidebar
        workspaces={[workspace]}
        selectedWorkspaceId={workspace.id}
        selectedThreadId={null}
        threads={[thread('active')]}
        metadata={{ active: metadata('active') }}
        approvals={{}}
        filter=""
        connectionState="ready"
        collapsed={false}
        onSelectWorkspace={vi.fn()}
        onAddWorkspace={vi.fn()}
        onNewThread={vi.fn()}
        onSelectThread={onSelectThread}
        onRenameThread={onRenameThread}
        onOpenThreadMenu={onOpenThreadMenu}
        onFilterChange={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenDiagnostics={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />
    );
    const row = screen.getByRole('option', { name: /Recent work/ });
    await user.click(row);
    expect(onSelectThread).toHaveBeenCalledWith('active');
    fireEvent.doubleClick(row);
    expect(onRenameThread).toHaveBeenCalledWith('active');
    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
    expect(onOpenThreadMenu).toHaveBeenCalledWith('active', 100, 120);
  });
});
