import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CodexSidebar } from '../../src/components/CodexSidebar';
import type { CodexThread, CodexThreadUiMetadata, Workspace } from '../../src/types';

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Project',
  path: '/tmp/project',
  workspaceType: 'local',
  isPinned: false,
  sortOrder: 0,
  isExpanded: true,
  isAvailable: true,
  gitPullOnMasterForNewThreads: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

const secondWorkspace: Workspace = {
  ...workspace,
  id: 'workspace-2',
  name: 'Utilities',
  path: '/tmp/utilities',
  sortOrder: 1,
  isExpanded: false
};

function thread(
  id: string,
  options: { archived?: boolean; workspacePath?: string; title?: string } = {}
): CodexThread {
  return {
    id,
    sessionId: id,
    title: options.title ?? (options.archived ? 'Archived work' : 'Recent work'),
    preview: 'Codex session',
    cwd: options.workspacePath ?? workspace.path,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: options.archived ? 1 : 2,
    status: 'idle',
    source: 'appServer',
    cliVersion: '0.144.0',
    archived: options.archived ?? false,
    turns: []
  };
}

function metadata(threadId: string, workspaceId = workspace.id): CodexThreadUiMetadata {
  return {
    threadId,
    workspaceId,
    fallbackTitle: threadId,
    pinned: false,
    unread: false,
    archived: false,
    draft: '',
    promptHistory: [],
    permissionMode: 'fullAccess',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  };
}

function sidebarProps(overrides: Record<string, unknown> = {}) {
  return {
    workspaces: [workspace, secondWorkspace],
    selectedWorkspaceId: workspace.id,
    selectedThreadId: 'active',
    threadsByWorkspace: {
      [workspace.id]: [thread('active'), thread('archived', { archived: true })],
      [secondWorkspace.id]: [
        thread('utility-thread', {
          workspacePath: secondWorkspace.path,
          title: 'Utility migration'
        })
      ]
    },
    metadata: {
      active: metadata('active'),
      archived: metadata('archived'),
      'utility-thread': metadata('utility-thread', secondWorkspace.id)
    },
    approvals: {},
    gitInfoByWorkspace: {},
    loadingWorkspaceIds: new Set<string>(),
    filter: '',
    sortMode: 'custom' as const,
    connectionState: 'ready' as const,
    collapsed: false,
    onSelectWorkspace: vi.fn(),
    onToggleWorkspace: vi.fn(),
    onAddAction: vi.fn(),
    onProjectsMenuAction: vi.fn(),
    onNewThread: vi.fn(),
    onSelectThread: vi.fn(),
    onRenameThread: vi.fn(),
    onOpenThreadMenu: vi.fn(),
    onOpenProjectMenu: vi.fn(),
    onReorderWorkspaces: vi.fn(),
    onLocateWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
    onCopyWorkspacePath: vi.fn(),
    onFilterChange: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenDiagnostics: vi.fn(),
    onToggleCollapsed: vi.fn(),
    ...overrides
  };
}

describe('Codex project shelf sidebar', () => {
  it('uses project shelves instead of a global project dropdown and keeps archives behind disclosure', async () => {
    render(<CodexSidebar {...sidebarProps()} />);

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Project/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Recent work/ })).toBeInTheDocument();
    expect(screen.queryByText('Archived work')).not.toBeInTheDocument();
    expect(screen.queryByText('Legacy imported session')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Show archived/ }));
    expect(screen.getByRole('treeitem', { name: /Archived work/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Hide archived/ }));
    expect(screen.queryByRole('treeitem', { name: /Archived work/ })).not.toBeInTheDocument();
  });

  it('opens and renames nested threads while preserving their project context', async () => {
    const onSelectThread = vi.fn();
    const onRenameThread = vi.fn();
    const onOpenThreadMenu = vi.fn();
    render(
      <CodexSidebar
        {...sidebarProps({ onSelectThread, onRenameThread, onOpenThreadMenu })}
      />
    );

    const row = screen.getByRole('treeitem', { name: /Recent work/ });
    await userEvent.click(row);
    expect(onSelectThread).toHaveBeenCalledWith(workspace.id, 'active');
    fireEvent.doubleClick(row);
    expect(onRenameThread).toHaveBeenCalledWith('active');
    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
    expect(onOpenThreadMenu).toHaveBeenCalledWith('active', 100, 120);
  });

  it('supports project selection, expansion, context menus, and project-scoped new threads', async () => {
    const onSelectWorkspace = vi.fn();
    const onToggleWorkspace = vi.fn();
    const onOpenProjectMenu = vi.fn();
    const onNewThread = vi.fn();
    render(
      <CodexSidebar
        {...sidebarProps({
          onSelectWorkspace,
          onToggleWorkspace,
          onOpenProjectMenu,
          onNewThread
        })}
      />
    );

    await userEvent.click(screen.getByRole('treeitem', { name: /Utilities/ }));
    expect(onSelectWorkspace).toHaveBeenCalledWith(secondWorkspace.id);
    expect(onToggleWorkspace).toHaveBeenCalledWith(secondWorkspace.id, true);

    const projectRow = screen.getByRole('treeitem', { name: /Project/ });
    fireEvent.contextMenu(projectRow, { clientX: 44, clientY: 55 });
    expect(onOpenProjectMenu).toHaveBeenCalledWith(workspace.id, 44, 55);

    await userEvent.click(
      screen.getByRole('button', { name: 'New thread' })
    );
    expect(onNewThread).toHaveBeenCalledWith(workspace.id);
  });

  it('searches projects and threads while retaining shelf context', () => {
    render(<CodexSidebar {...sidebarProps({ filter: 'migration' })} />);
    expect(screen.getByRole('treeitem', { name: /Utilities/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Utility migration/ })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: /^Project/ })).not.toBeInTheDocument();
  });

  it('persists custom drag ordering through the reorder callback', () => {
    const onReorderWorkspaces = vi.fn();
    render(<CodexSidebar {...sidebarProps({ onReorderWorkspaces })} />);
    const source = screen.getByText('Project').closest('.project-shelf-header');
    const target = screen.getByText('Utilities').closest('.project-shelf');
    target!.getBoundingClientRect = () => ({
      top: -100,
      bottom: 0,
      left: 0,
      right: 100,
      width: 100,
      height: 100,
      x: 0,
      y: -100,
      toJSON: () => ({})
    });
    const dataTransfer = {
      effectAllowed: '',
      setData: vi.fn(),
      getData: vi.fn()
    };
    fireEvent.dragStart(source!, { dataTransfer });
    fireEvent.dragOver(target!, { dataTransfer, clientY: 99 });
    fireEvent.drop(target!, { dataTransfer, clientY: 99 });
    expect(onReorderWorkspaces).toHaveBeenCalledWith([
      secondWorkspace.id,
      workspace.id
    ]);
  });

  it('uses tree keyboard navigation and accessible context menu shortcuts', () => {
    const onToggleWorkspace = vi.fn();
    const onOpenProjectMenu = vi.fn();
    render(
      <CodexSidebar
        {...sidebarProps({ onToggleWorkspace, onOpenProjectMenu })}
      />
    );
    const project = screen.getByRole('treeitem', { name: /Project/ });
    project.focus();
    fireEvent.keyDown(project, { key: 'ArrowLeft' });
    expect(onToggleWorkspace).toHaveBeenCalledWith(workspace.id, false);
    fireEvent.keyDown(project, { key: 'F10', shiftKey: true });
    expect(onOpenProjectMenu).toHaveBeenCalledWith(
      workspace.id,
      expect.any(Number),
      expect.any(Number)
    );
  });
});
