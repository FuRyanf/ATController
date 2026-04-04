import * as React from 'react';
import { createPortal } from 'react-dom';
import type { CreateThreadOptions, ThreadMetadata, Workspace } from '../types';

interface LeftRailProps {
  sidebarWidth: number;
  workspaces: Workspace[];
  threadsByWorkspace: Record<string, ThreadMetadata[]>;
  selectedWorkspaceId?: string;
  selectedThreadId?: string;
  threadSearch: string;
  defaultNewThreadFullAccess?: boolean;
  creatingThreadByWorkspace?: Record<string, boolean>;
  isThreadWorking?: (threadId: string) => boolean;
  hasUnreadThreadOutput?: (threadId: string) => boolean;
  getThreadDisplayTimestampMs: (thread: ThreadMetadata) => number;
  onOpenWorkspacePicker: () => void;
  onOpenSettings: () => void;
  onNewThreadInWorkspace: (workspaceId: string, options?: CreateThreadOptions) => Promise<void>;
  onThreadSearchChange: (value: string) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onRenameThread: (workspaceId: string, threadId: string, title: string) => Promise<void>;
  onDeleteThread: (workspaceId: string, threadId: string) => Promise<void>;
  onOpenWorkspaceInFinder: (workspace: Workspace) => void;
  onOpenWorkspaceInTerminal: (workspace: Workspace) => void;
  onSetWorkspaceGitPullOnMasterForNewThreads: (workspaceId: string, enabled: boolean) => Promise<void>;
  onReorderWorkspaces: (workspaceIds: string[]) => Promise<void>;
  onRemoveWorkspace: (workspace: Workspace) => Promise<void>;
  getSearchTextForThread?: (threadId: string) => string;
  onCopyResumeCommand: (thread: ThreadMetadata) => void;
  onCopyWorkspaceCommand: (workspace: Workspace) => void;
  onImportSession: (workspace: Workspace) => void;
}

interface ThreadContextMenuState {
  thread: ThreadMetadata;
  x: number;
  y: number;
}

interface WorkspaceContextMenuState {
  workspace: Workspace;
  x: number;
  y: number;
}

interface NewThreadMenuState {
  workspaceId: string;
  x: number;
  y: number;
}

const CONTEXT_MENU_WIDTH = 220;
const THREAD_CONTEXT_MENU_HEIGHT = 160;
const WORKSPACE_CONTEXT_MENU_HEIGHT = 250;
const NEW_THREAD_CONTEXT_MENU_HEIGHT = 88;
const CONTEXT_MENU_MARGIN = 8;

function isRemoteWorkspaceKind(kind: Workspace['kind']): boolean {
  return kind === 'ssh';
}

function clampMenuCoordinate(x: number, y: number, width: number, height: number) {
  const maxX = Math.max(CONTEXT_MENU_MARGIN, window.innerWidth - width - CONTEXT_MENU_MARGIN);
  const maxY = Math.max(CONTEXT_MENU_MARGIN, window.innerHeight - height - CONTEXT_MENU_MARGIN);
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(x, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(y, maxY))
  };
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 6.75A1.75 1.75 0 0 1 4.75 5h4.1c.56 0 1.08.27 1.41.72l.76 1.03c.14.2.37.31.61.31h7.67A1.75 1.75 0 0 1 21 8.8v8.45A1.75 1.75 0 0 1 19.25 19H4.75A1.75 1.75 0 0 1 3 17.25V6.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={expanded ? 'workspace-chevron-icon expanded' : 'workspace-chevron-icon'}>
      <path d="m9 6 5.5 6L9 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3.75 7A1.75 1.75 0 0 1 5.5 5.25h4c.56 0 1.08.26 1.41.72l.71.97c.14.2.37.31.62.31h6.26A1.75 1.75 0 0 1 20.25 9v7.5a1.75 1.75 0 0 1-1.75 1.75H5.5a1.75 1.75 0 0 1-1.75-1.75V7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M16.5 10.25v5.5M13.75 13h5.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 18V6M12 6l-4.5 4.5M12 6l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 6v12M12 18l-4.5-4.5M12 18l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.8 7.2h14.4M9.5 4.8h5M8.3 7.2l.7 10.4a1.2 1.2 0 0 0 1.2 1.1h3.6a1.2 1.2 0 0 0 1.2-1.1l.7-10.4M10.3 10.4v5.8M13.7 10.4v5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M11.98 3.75h.04a1.3 1.3 0 0 1 1.26 1.01l.26 1.12a6.8 6.8 0 0 1 1.42.59l.98-.61a1.3 1.3 0 0 1 1.58.18l.03.03a1.3 1.3 0 0 1 .18 1.58l-.61.98c.23.45.43.92.59 1.42l1.12.26a1.3 1.3 0 0 1 1.01 1.26v.04a1.3 1.3 0 0 1-1.01 1.26l-1.12.26a6.8 6.8 0 0 1-.59 1.42l.61.98a1.3 1.3 0 0 1-.18 1.58l-.03.03a1.3 1.3 0 0 1-1.58.18l-.98-.61c-.45.23-.92.43-1.42.59l-.26 1.12a1.3 1.3 0 0 1-1.26 1.01h-.04a1.3 1.3 0 0 1-1.26-1.01l-.26-1.12a6.8 6.8 0 0 1-1.42-.59l-.98.61a1.3 1.3 0 0 1-1.58-.18l-.03-.03a1.3 1.3 0 0 1-.18-1.58l.61-.98a6.8 6.8 0 0 1-.59-1.42l-1.12-.26A1.3 1.3 0 0 1 3.75 12v-.04a1.3 1.3 0 0 1 1.01-1.26l1.12-.26c.16-.5.36-.97.59-1.42l-.61-.98a1.3 1.3 0 0 1 .18-1.58l.03-.03a1.3 1.3 0 0 1 1.58-.18l.98.61c.45-.23.92-.43 1.42-.59l.26-1.12a1.3 1.3 0 0 1 1.26-1.01Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function formatRecencyShort(activityTimestampMs: number | null, nowMs: number): string | null {
  if (!activityTimestampMs) {
    return null;
  }

  const diffMs = Math.max(0, nowMs - activityTimestampMs);
  if (diffMs < 60_000) {
    return null;
  }

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d`;
  }

  return `${diffDays}d`;
}

function buildShiftedWorkspaceIds(workspaces: Workspace[], workspaceId: string, offset: -1 | 1): string[] | null {
  const ids = workspaces.map((workspace) => workspace.id);
  const fromIndex = ids.indexOf(workspaceId);
  if (fromIndex < 0) {
    return null;
  }
  const toIndex = fromIndex + offset;
  if (toIndex < 0 || toIndex >= ids.length) {
    return null;
  }
  const moving = ids[fromIndex];
  ids[fromIndex] = ids[toIndex];
  ids[toIndex] = moving;
  return ids;
}

interface ThreadRowProps {
  thread: ThreadMetadata;
  active: boolean;
  relativeTime: string | null;
  isWorking: boolean;
  hasUnreadOutput: boolean;
  isEditing: boolean;
  editingValue: string;
  onEditingValueChange: (value: string) => void;
  onStartRename: (thread: ThreadMetadata) => void;
  onCommitRename: (thread: ThreadMetadata) => Promise<void>;
  onCancelRename: () => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onOpenThreadContextMenu: (event: React.MouseEvent, thread: ThreadMetadata) => void;
  onDeleteThread: (workspaceId: string, threadId: string) => Promise<void>;
}

const ThreadRow = React.memo(function ThreadRow({
  thread,
  active,
  relativeTime,
  isWorking,
  hasUnreadOutput,
  isEditing,
  editingValue,
  onEditingValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onSelectThread,
  onOpenThreadContextMenu,
  onDeleteThread
}: ThreadRowProps) {
  const skipBlurCommitRef = React.useRef(false);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (!isEditing) {
      skipBlurCommitRef.current = false;
    }
  }, [isEditing]);
  React.useEffect(() => {
    if (!isEditing) {
      return;
    }
    const focusId = window.requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      const cursor = input.value.length;
      input.setSelectionRange(cursor, cursor);
    });
    return () => {
      window.cancelAnimationFrame(focusId);
    };
  }, [isEditing]);

  const rowContent = (
    <span className="thread-main-row">
      <span className="thread-main-leading">
        {isEditing ? (
          <input
            ref={renameInputRef}
            className="thread-rename-input"
            value={editingValue}
            maxLength={80}
            autoFocus
            onChange={(event) => onEditingValueChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={async (event) => {
              // Keep keyboard input local to rename mode; don't bubble shortcuts to the app.
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                skipBlurCommitRef.current = true;
                onCancelRename();
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                skipBlurCommitRef.current = true;
                await onCommitRename(thread);
                return;
              }
            }}
            onKeyUp={(event) => {
              event.stopPropagation();
            }}
            onBlur={async () => {
              if (skipBlurCommitRef.current) {
                skipBlurCommitRef.current = false;
                return;
              }
              await onCommitRename(thread);
            }}
          />
        ) : (
          <span
            className="thread-title"
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onStartRename(thread);
            }}
          >
            {thread.title}
          </span>
        )}
      </span>
      <span className="thread-main-trailing">
        {isWorking ? (
          <span className="thread-running" data-testid={`thread-running-${thread.id}`} aria-label="Thread is working">
            <span className="spinner-dot" />
          </span>
        ) : hasUnreadOutput && !active ? (
          <span className="thread-unread-dot" data-testid={`thread-unread-${thread.id}`} aria-label="Unread output" />
        ) : relativeTime ? (
          <span className="thread-time" data-testid={`thread-recency-${thread.id}`}>
            {relativeTime}
          </span>
        ) : null}
      </span>
    </span>
  );

  return (
    <li
      key={thread.id}
      className={active ? 'thread-item active' : 'thread-item'}
      data-thread-id={thread.id}
      onContextMenu={(event) => {
        onOpenThreadContextMenu(event, thread);
      }}
    >
      {isEditing ? (
        <div className={active ? 'thread-button active thread-button-editing' : 'thread-button thread-button-editing'}>
          {rowContent}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSelectThread(thread.workspaceId, thread.id)}
          onDoubleClick={(event) => {
            event.preventDefault();
            onStartRename(thread);
          }}
          className={active ? 'thread-button active' : 'thread-button'}
        >
          {rowContent}
        </button>
      )}
      <button
        type="button"
        className="thread-delete-button"
        aria-label="Delete thread"
        title={`Delete ${thread.title}`}
        tabIndex={-1}
        onClick={async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await onDeleteThread(thread.workspaceId, thread.id);
        }}
      >
        <TrashIcon />
      </button>
    </li>
  );
});

function LeftRailComponent({
  sidebarWidth,
  workspaces,
  threadsByWorkspace,
  selectedWorkspaceId,
  selectedThreadId,
  threadSearch,
  defaultNewThreadFullAccess = false,
  creatingThreadByWorkspace = {},
  isThreadWorking,
  hasUnreadThreadOutput,
  getThreadDisplayTimestampMs,
  onOpenWorkspacePicker,
  onOpenSettings,
  onNewThreadInWorkspace,
  onThreadSearchChange,
  onSelectThread,
  onRenameThread,
  onDeleteThread,
  onOpenWorkspaceInFinder,
  onOpenWorkspaceInTerminal,
  onSetWorkspaceGitPullOnMasterForNewThreads,
  onReorderWorkspaces,
  onRemoveWorkspace,
  getSearchTextForThread,
  onCopyResumeCommand,
  onCopyWorkspaceCommand,
  onImportSession
}: LeftRailProps) {
  const [editingThreadId, setEditingThreadId] = React.useState<string | null>(null);
  const [editingValue, setEditingValue] = React.useState('');
  const [editingOriginal, setEditingOriginal] = React.useState('');
  const [contextMenu, setContextMenu] = React.useState<ThreadContextMenuState | null>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] = React.useState<WorkspaceContextMenuState | null>(null);
  const [newThreadMenu, setNewThreadMenu] = React.useState<NewThreadMenuState | null>(null);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState<Record<string, boolean>>({});
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const workspaceContextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const newThreadMenuRef = React.useRef<HTMLDivElement | null>(null);
  const renderCountRef = React.useRef(0);
  renderCountRef.current += 1;

  const query = threadSearch.trim().toLowerCase();
  const [nowMs, setNowMs] = React.useState(Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    if (!contextMenu && !workspaceContextMenu && !newThreadMenu) {
      return;
    }

    const closeMenu = (event: Event) => {
      if (
        contextMenuRef.current?.contains(event.target as Node) ||
        workspaceContextMenuRef.current?.contains(event.target as Node) ||
        newThreadMenuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setContextMenu(null);
      setWorkspaceContextMenu(null);
      setNewThreadMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setWorkspaceContextMenu(null);
        setNewThreadMenu(null);
      }
    };

    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', onEscape);

    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, [contextMenu, newThreadMenu, workspaceContextMenu]);

  React.useEffect(() => {
    setExpandedWorkspaceIds((current) => {
      const next: Record<string, boolean> = {};
      for (const workspace of workspaces) {
        next[workspace.id] = current[workspace.id] ?? true;
      }
      return next;
    });
  }, [workspaces]);

  const commitRename = React.useCallback(
    async (thread: ThreadMetadata) => {
      const trimmed = editingValue.trim().slice(0, 80);
      if (!trimmed) {
        setEditingThreadId(null);
        setEditingValue('');
        setEditingOriginal('');
        return;
      }

      if (trimmed !== editingOriginal) {
        await onRenameThread(thread.workspaceId, thread.id, trimmed);
      }

      setEditingThreadId(null);
      setEditingValue('');
      setEditingOriginal('');
    },
    [editingOriginal, editingValue, onRenameThread]
  );

  const onOpenThreadContextMenu = React.useCallback((event: React.MouseEvent, thread: ThreadMetadata) => {
    event.preventDefault();
    const { x, y } = clampMenuCoordinate(
      event.clientX,
      event.clientY,
      CONTEXT_MENU_WIDTH,
      THREAD_CONTEXT_MENU_HEIGHT
    );
    setWorkspaceContextMenu(null);
    setContextMenu({ thread, x, y });
  }, []);

  const onStartRename = React.useCallback((thread: ThreadMetadata) => {
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        active.blur();
      }
    }
    setEditingThreadId(thread.id);
    setEditingValue(thread.title);
    setEditingOriginal(thread.title);
  }, []);

  const onCancelRename = React.useCallback(() => {
    setEditingThreadId(null);
    setEditingValue('');
    setEditingOriginal('');
  }, []);

  const openNewThreadMenu = React.useCallback((workspaceId: string, x: number, y: number) => {
    const position = clampMenuCoordinate(
      x,
      y,
      CONTEXT_MENU_WIDTH,
      NEW_THREAD_CONTEXT_MENU_HEIGHT
    );
    setContextMenu(null);
    setWorkspaceContextMenu(null);
    setNewThreadMenu({ workspaceId, ...position });
  }, []);

  const menuLayer =
    typeof document === 'undefined'
      ? null
      : createPortal(
          <>
            {contextMenu ? (
              <div className="thread-context-menu" ref={contextMenuRef} style={{ left: contextMenu.x, top: contextMenu.y }}>
                <button
                  type="button"
                  onClick={() => {
                    onStartRename(contextMenu.thread);
                    setContextMenu(null);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={!contextMenu.thread.claudeSessionId?.trim()}
                  onClick={() => {
                    onCopyResumeCommand(contextMenu.thread);
                    setContextMenu(null);
                  }}
                >
                  Copy resume command
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={async () => {
                    setContextMenu(null);
                    await onDeleteThread(contextMenu.thread.workspaceId, contextMenu.thread.id);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}

            {workspaceContextMenu ? (
              <div
                className="thread-context-menu"
                ref={workspaceContextMenuRef}
                style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y }}
              >
                <button
                  type="button"
                  onClick={() => {
                    onOpenWorkspaceInFinder(workspaceContextMenu.workspace);
                    setWorkspaceContextMenu(null);
                  }}
                  disabled={isRemoteWorkspaceKind(workspaceContextMenu.workspace.kind)}
                >
                  Open folder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onOpenWorkspaceInTerminal(workspaceContextMenu.workspace);
                    setWorkspaceContextMenu(null);
                  }}
                >
                  {isRemoteWorkspaceKind(workspaceContextMenu.workspace.kind) ? 'Open remote shell' : 'Open terminal'}
                </button>
                {isRemoteWorkspaceKind(workspaceContextMenu.workspace.kind) && (
                  <button
                    type="button"
                    onClick={() => {
                      onCopyWorkspaceCommand(workspaceContextMenu.workspace);
                      setWorkspaceContextMenu(null);
                    }}
                  >
                    Copy SSH command
                  </button>
                )}
                {workspaceContextMenu.workspace.kind === 'local' ? (
                  <button
                    type="button"
                    onClick={async () => {
                      const workspace = workspaceContextMenu.workspace;
                      const enabled = !workspace.gitPullOnMasterForNewThreads;
                      setWorkspaceContextMenu(null);
                      await onSetWorkspaceGitPullOnMasterForNewThreads(workspace.id, enabled);
                    }}
                  >
                    {workspaceContextMenu.workspace.gitPullOnMasterForNewThreads
                      ? 'Disable git pull on master for new threads'
                      : 'Enable git pull on master for new threads'}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    const workspace = workspaceContextMenu.workspace;
                    setWorkspaceContextMenu(null);
                    onImportSession(workspace);
                  }}
                >
                  Import session…
                </button>
                <div className="thread-context-divider" />
                <button
                  type="button"
                  className="danger"
                  onClick={async () => {
                    const workspace = workspaceContextMenu.workspace;
                    setWorkspaceContextMenu(null);
                    await onRemoveWorkspace(workspace);
                  }}
                >
                  Remove project
                </button>
              </div>
            ) : null}

            {newThreadMenu ? (
              <div
                className="thread-context-menu"
                ref={newThreadMenuRef}
                style={{ left: newThreadMenu.x, top: newThreadMenu.y }}
              >
                <button
                  type="button"
                  onClick={async () => {
                    const workspaceId = newThreadMenu.workspaceId;
                    setNewThreadMenu(null);
                    await onNewThreadInWorkspace(workspaceId, { fullAccess: false });
                  }}
                >
                  Normal thread
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const workspaceId = newThreadMenu.workspaceId;
                    setNewThreadMenu(null);
                    await onNewThreadInWorkspace(workspaceId, { fullAccess: true });
                  }}
                >
                  Full access thread
                </button>
              </div>
            ) : null}
          </>,
          document.body
        );

  return (
    <aside
      className="left-rail"
      data-testid="sidebar"
      aria-label="Workspace sidebar"
      style={{ width: sidebarWidth }}
      data-render-count={import.meta.env.MODE === 'test' ? renderCountRef.current : undefined}
    >
      <div className="workspace-controls codex-rail-header">
        <div className="codex-rail-title-row">
          <label>Threads</label>
          <div className="codex-rail-toolbar">
            <button
              type="button"
              className="icon-ghost-button add-project-button"
              onClick={onOpenWorkspacePicker}
              title="Add new project"
              aria-label="Add new project"
            >
              <span className="rail-icon" aria-hidden="true">
                <FolderPlusIcon />
              </span>
              <span>Add project</span>
            </button>
          </div>
        </div>

        <div className="thread-search codex-thread-search">
          <span className="search-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M16 16l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="text"
            value={threadSearch}
            onChange={(event) => onThreadSearchChange(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
          />
        </div>
      </div>

      <div className="thread-groups">
        <ul className="workspace-groups">
          {workspaces.map((workspace, workspaceIndex) => {
            const isSelectedWorkspace = workspace.id === selectedWorkspaceId;
            const isExpanded = expandedWorkspaceIds[workspace.id] !== false;
            const isRemoteWorkspace = isRemoteWorkspaceKind(workspace.kind);
            const isCreatingThread = Boolean(creatingThreadByWorkspace[workspace.id]);
            const gitPullEnabled = workspace.kind === 'local' && Boolean(workspace.gitPullOnMasterForNewThreads);
            const allThreads = threadsByWorkspace[workspace.id] ?? [];
            const visibleThreads = allThreads.filter((thread) => {
              if (!query) {
                return true;
              }
              const titleMatch = thread.title.toLowerCase().includes(query);
              const contentMatch = (getSearchTextForThread?.(thread.id) ?? '').toLowerCase().includes(query);
              return titleMatch || contentMatch;
            });

            return (
              <li
                key={workspace.id}
                className={
                  [
                    'workspace-group',
                    isSelectedWorkspace ? 'selected' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')
                }
                data-expanded={isExpanded ? 'true' : 'false'}
              >
                <div className="workspace-group-container">
                  <div className="workspace-group-row">
                    <button
                      type="button"
                      className="workspace-group-button"
                      onClick={() => {
                        setExpandedWorkspaceIds((current) => ({
                          ...current,
                          [workspace.id]: !(current[workspace.id] ?? true)
                        }));
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        const { x, y } = clampMenuCoordinate(
                          event.clientX,
                          event.clientY,
                          CONTEXT_MENU_WIDTH,
                          WORKSPACE_CONTEXT_MENU_HEIGHT
                        );
                        setContextMenu(null);
                        setWorkspaceContextMenu({ workspace, x, y });
                      }}
                    >
                      <span className="workspace-group-leading">
                        <span
                          className="workspace-chevron workspace-chevron-button"
                          role="button"
                          tabIndex={0}
                          aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setExpandedWorkspaceIds((current) => ({
                              ...current,
                              [workspace.id]: !(current[workspace.id] ?? true)
                            }));
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') {
                              return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            setExpandedWorkspaceIds((current) => ({
                              ...current,
                              [workspace.id]: !(current[workspace.id] ?? true)
                            }));
                          }}
                        >
                          <ChevronIcon expanded={isExpanded} />
                        </span>
                        <span className="workspace-folder-icon" aria-hidden="true">
                          <FolderIcon />
                        </span>
                        <span className="workspace-group-name">{workspace.name}</span>
                        {isRemoteWorkspace ? <span className="workspace-kind-tag">{workspace.kind}</span> : null}
                        {gitPullEnabled ? (
                          <span
                            className="workspace-git-pull-label"
                            title="Upon new threads, master is checked out and pulled automatically."
                            aria-label="master pull enabled for new threads"
                          >
                            master pull enabled
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <span className="workspace-group-actions">
                      {workspaceIndex > 0 ? (
                        <button
                          type="button"
                          className="workspace-action-button workspace-order-button"
                          aria-label="Move project up"
                          title="Move project up"
                          data-testid={`workspace-move-up-${workspace.id}`}
                          tabIndex={-1}
                          onClick={async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const nextWorkspaceOrder = buildShiftedWorkspaceIds(workspaces, workspace.id, -1);
                            if (!nextWorkspaceOrder) {
                              return;
                            }
                            await onReorderWorkspaces(nextWorkspaceOrder);
                          }}
                        >
                          <ArrowUpIcon />
                        </button>
                      ) : null}
                      {workspaceIndex < workspaces.length - 1 ? (
                        <button
                          type="button"
                          className="workspace-action-button workspace-order-button"
                          aria-label="Move project down"
                          title="Move project down"
                          data-testid={`workspace-move-down-${workspace.id}`}
                          tabIndex={-1}
                          onClick={async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const nextWorkspaceOrder = buildShiftedWorkspaceIds(workspaces, workspace.id, 1);
                            if (!nextWorkspaceOrder) {
                              return;
                            }
                            await onReorderWorkspaces(nextWorkspaceOrder);
                          }}
                        >
                          <ArrowDownIcon />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="workspace-action-button"
                        aria-label="Workspace actions"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          const { x, y } = clampMenuCoordinate(
                            rect.right - CONTEXT_MENU_WIDTH,
                            rect.bottom + 8,
                            CONTEXT_MENU_WIDTH,
                            WORKSPACE_CONTEXT_MENU_HEIGHT
                          );
                          setContextMenu(null);
                          setWorkspaceContextMenu({ workspace, x, y });
                        }}
                      >
                        <DotsIcon />
                      </button>
                    </span>
                  </div>

                  {!isExpanded ? null : (
                    <div className="workspace-group-children">
                      <div className="workspace-new-thread-row-group">
                        <button
                          type="button"
                          className={
                            defaultNewThreadFullAccess
                              ? 'workspace-new-thread-row workspace-new-thread-main full-access-default'
                              : 'workspace-new-thread-row workspace-new-thread-main'
                          }
                          data-testid={`workspace-new-thread-${workspace.id}`}
                          disabled={isCreatingThread}
                          aria-busy={isCreatingThread}
                          onClick={async () => {
                            setNewThreadMenu(null);
                            await onNewThreadInWorkspace(workspace.id, { fullAccess: defaultNewThreadFullAccess });
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            openNewThreadMenu(workspace.id, event.clientX, event.clientY);
                          }}
                        >
                          <span className="workspace-new-thread-icon" aria-hidden="true">
                            <PlusIcon />
                          </span>
                          <span>{defaultNewThreadFullAccess ? 'New full access thread' : 'New thread'}</span>
                        </button>
                        <button
                          type="button"
                          className={
                            defaultNewThreadFullAccess
                              ? 'workspace-new-thread-options-button full-access-default'
                              : 'workspace-new-thread-options-button'
                          }
                          data-testid={`workspace-new-thread-options-${workspace.id}`}
                          aria-label="New thread options"
                          title="New thread options"
                          disabled={isCreatingThread}
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            openNewThreadMenu(workspace.id, rect.right - CONTEXT_MENU_WIDTH, rect.bottom + 8);
                          }}
                        >
                          <ChevronDownIcon />
                        </button>
                      </div>
                      {visibleThreads.length > 0 ? (
                        <ul className="workspace-thread-list">
                          {visibleThreads.map((thread) => {
                            return (
                              <ThreadRow
                                key={thread.id}
                                thread={thread}
                                active={thread.id === selectedThreadId}
                                relativeTime={formatRecencyShort(
                                  getThreadDisplayTimestampMs(thread) || null,
                                  nowMs
                                )}
                                isWorking={Boolean(isThreadWorking?.(thread.id))}
                                hasUnreadOutput={Boolean(hasUnreadThreadOutput?.(thread.id))}
                                isEditing={editingThreadId === thread.id}
                                editingValue={editingValue}
                                onEditingValueChange={setEditingValue}
                                onStartRename={onStartRename}
                                onCommitRename={commitRename}
                                onCancelRename={onCancelRename}
                                onSelectThread={onSelectThread}
                                onOpenThreadContextMenu={onOpenThreadContextMenu}
                                onDeleteThread={onDeleteThread}
                              />
                            );
                          })}
                        </ul>
                      ) : query && allThreads.length > 0 ? (
                        <p className="muted workspace-group-empty">No matching threads.</p>
                      ) : null}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="left-rail-footer">
        <div className="left-rail-footer-links">
          <button type="button" className="rail-footer-button" onClick={onOpenSettings}>
            <span className="rail-footer-icon" aria-hidden="true">
              <GearIcon />
            </span>
            <span>Settings</span>
          </button>
        </div>
      </div>
      {menuLayer}
    </aside>
  );
}

export const LeftRail = React.memo(LeftRailComponent);
