import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  CodexSidebar,
  sidebarThreadStateEqual
} from '../../src/components/CodexSidebar';
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
  options: {
    archived?: boolean;
    workspacePath?: string;
    title?: string;
    updatedAt?: number;
  } = {}
): CodexThread {
  return {
    id,
    sessionId: id,
    title: options.title ?? (options.archived ? 'Archived work' : 'Recent work'),
    preview: 'Codex session',
    cwd: options.workspacePath ?? workspace.path,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: options.updatedAt ?? (options.archived ? 1 : 2),
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
    fiveHourLimit: { usedPercent: 25, resetsAt: 1_786_048_200 },
    weeklyLimit: { usedPercent: 60, resetsAt: 1_786_566_600 },
    collapsed: false,
    onSelectWorkspace: vi.fn(),
    onToggleWorkspace: vi.fn(),
    onAddAction: vi.fn(),
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
  it('keeps usage visible on the Settings entry and opens Settings', async () => {
    const properties = sidebarProps();
    render(<CodexSidebar {...properties} />);

    const settings = screen.getByRole('button', {
      name: 'Settings and Codex usage'
    });
    expect(settings).toHaveTextContent('5h 75%');
    expect(settings).toHaveTextContent('W 40%');
    expect(settings).toHaveAttribute('title', expect.stringContaining('Resets'));
    await userEvent.click(settings);
    expect(properties.onOpenSettings).toHaveBeenCalledOnce();
  });

  it('ignores transcript-only changes when comparing sidebar thread state', () => {
    const before = {
      ...thread('active'),
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          itemsView: 'full' as const,
          items: []
        }
      ]
    };
    const after = {
      ...before,
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          itemsView: 'full' as const,
          items: [
            {
              id: 'agent-1',
              kind: 'agentMessage',
              text: 'A large streamed response that the sidebar never renders.',
              summary: [],
              reasoning: [],
              content: [],
              changes: []
            }
          ]
        }
      ]
    };
    expect(sidebarThreadStateEqual(before, after)).toBe(true);
    expect(
      sidebarThreadStateEqual(before, { ...after, preview: 'Updated preview' })
    ).toBe(false);
  });

  it('puts the compact creation actions above projects without duplicate header menus', () => {
    const { container } = render(<CodexSidebar {...sidebarProps()} />);
    const quickActions = container.querySelector('.sidebar-global-actions-top');
    const projectsHeader = container.querySelector('.projects-section-header');

    expect(quickActions).not.toBeNull();
    expect(projectsHeader).not.toBeNull();
    expect(
      quickActions!.compareDocumentPosition(projectsHeader!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add project' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Project organization' })
    ).not.toBeInTheDocument();
  });

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

  it('reorders projects with explicit up and down arrow buttons', async () => {
    const onReorderWorkspaces = vi.fn();
    const onSelectWorkspace = vi.fn();
    render(
      <CodexSidebar
        {...sidebarProps({ onReorderWorkspaces, onSelectWorkspace })}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Move Project up' })
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Move Project down' })
    );
    expect(onReorderWorkspaces).toHaveBeenCalledWith([
      secondWorkspace.id,
      workspace.id
    ]);
    expect(screen.queryByLabelText('Reorder Project')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('treeitem', { name: /Project/ }));
    expect(onSelectWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  it('sorts thread rows by latest activity and ignores legacy custom order', () => {
    const onSelectThread = vi.fn();
    const { container } = render(
      <CodexSidebar
        {...sidebarProps({
          selectedThreadId: 'second',
          threadsByWorkspace: {
            [workspace.id]: [
              thread('first', { title: 'First thread', updatedAt: 10 }),
              thread('second', { title: 'Second thread', updatedAt: 20 })
            ],
            [secondWorkspace.id]: []
          },
          metadata: {
            first: { ...metadata('first'), sortOrder: 0 },
            second: { ...metadata('second'), sortOrder: 99 }
          },
          onSelectThread
        })}
      />
    );
    const rows = [
      ...container.querySelectorAll<HTMLElement>('[data-thread-id]')
    ];
    expect(rows.map((row) => row.dataset.threadId)).toEqual([
      'second',
      'first'
    ]);
    expect(container.querySelector('[data-thread-drag-row]')).toBeNull();

    const source = screen.getByRole('treeitem', { name: /Second thread/ });
    expect(source).not.toHaveAttribute('aria-grabbed');
    fireEvent.pointerDown(source, {
      button: 0,
      pointerId: 7,
      clientX: 12,
      clientY: 12
    });
    fireEvent.pointerMove(source, {
      pointerId: 7,
      clientX: 12,
      clientY: 88
    });
    fireEvent.pointerUp(source, {
      pointerId: 7,
      clientX: 12,
      clientY: 88
    });
    fireEvent.click(source);
    expect(onSelectThread).toHaveBeenCalledWith(workspace.id, 'second');
  });

  it('keeps project rows as immediate click targets without a drag state', () => {
    const onSelectWorkspace = vi.fn();
    const onReorderWorkspaces = vi.fn();
    render(
      <CodexSidebar
        {...sidebarProps({ onSelectWorkspace, onReorderWorkspaces })}
      />
    );
    const project = screen.getByRole('treeitem', { name: /Project/ });
    fireEvent.click(project);
    expect(onSelectWorkspace).toHaveBeenCalledWith(workspace.id);
    expect(onReorderWorkspaces).not.toHaveBeenCalled();
    expect(project).not.toHaveAttribute('aria-grabbed');
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
