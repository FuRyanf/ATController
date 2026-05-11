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
  elevatedAccessLabel?: string;
  creatingThreadByWorkspace?: Record<string, boolean>;
  isThreadWorking?: (threadId: string) => boolean;
  unreadCompletedTurnByThread?: Record<string, true>;
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
  onOpenResumeCommandInTerminal: (thread: ThreadMetadata) => void;
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
const THREAD_CONTEXT_MENU_HEIGHT = 196;
const WORKSPACE_CONTEXT_MENU_HEIGHT = 250;
const NEW_THREAD_CONTEXT_MENU_HEIGHT = 88;
const CONTEXT_MENU_MARGIN = 8;

type WorkspaceDropPosition = 'before' | 'after';

interface WorkspaceDragState {
  draggedWorkspaceId: string;
  overWorkspaceId?: string;
  dropPosition?: WorkspaceDropPosition;
}

interface WorkspaceDragSession {
  workspaceId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  overWorkspaceId?: string;
  dropPosition?: WorkspaceDropPosition;
  cleanup: () => void;
}

interface WorkspaceDragTarget {
  element: HTMLElement;
  workspaceId: string;
}

function isRemoteWorkspaceKind(kind: Workspace['kind']): boolean {
  return kind === 'rdev' || kind === 'ssh';
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

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="6.5" r="1.25" fill="currentColor" />
      <circle cx="15" cy="6.5" r="1.25" fill="currentColor" />
      <circle cx="9" cy="12" r="1.25" fill="currentColor" />
      <circle cx="15" cy="12" r="1.25" fill="currentColor" />
      <circle cx="9" cy="17.5" r="1.25" fill="currentColor" />
      <circle cx="15" cy="17.5" r="1.25" fill="currentColor" />
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

function buildDraggedWorkspaceIds(
  workspaces: Workspace[],
  draggedWorkspaceId: string,
  targetWorkspaceId: string,
  position: WorkspaceDropPosition
): string[] | null {
  if (draggedWorkspaceId === targetWorkspaceId) {
    return null;
  }

  const ids = workspaces.map((workspace) => workspace.id);
  const fromIndex = ids.indexOf(draggedWorkspaceId);
  if (fromIndex < 0) {
    return null;
  }

  ids.splice(fromIndex, 1);
  const targetIndex = ids.indexOf(targetWorkspaceId);
  if (targetIndex < 0) {
    return null;
  }

  ids.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, draggedWorkspaceId);
  return ids;
}

function resolveWorkspaceDropPositionFromRect(
  clientY: number,
  targetRect: DOMRect,
  workspaces: Workspace[],
  draggedWorkspaceId: string,
  targetWorkspaceId: string
): WorkspaceDropPosition {
  if (targetRect.height > 0) {
    return clientY >= targetRect.top + targetRect.height / 2 ? 'after' : 'before';
  }

  const draggedIndex = workspaces.findIndex((workspace) => workspace.id === draggedWorkspaceId);
  const targetIndex = workspaces.findIndex((workspace) => workspace.id === targetWorkspaceId);
  return draggedIndex < targetIndex ? 'after' : 'before';
}

interface ThreadRowProps {
  thread: ThreadMetadata;
  active: boolean;
  relativeTime: string | null;
  isWorking: boolean;
  hasUnreadCompletedTurn: boolean;
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
  hasUnreadCompletedTurn,
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
        ) : hasUnreadCompletedTurn ? (
          <span
            className="thread-unread-dot"
            data-testid={`thread-unread-${thread.id}`}
            aria-label="Thread has an unread completed turn"
          />
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
  elevatedAccessLabel = 'Full access',
  creatingThreadByWorkspace = {},
  isThreadWorking,
  unreadCompletedTurnByThread = {},
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
  onOpenResumeCommandInTerminal,
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
  const elevatedAccessLabelLower = elevatedAccessLabel.toLowerCase();
  const [workspaceDragState, setWorkspaceDragState] = React.useState<WorkspaceDragState | null>(null);
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const workspaceContextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const newThreadMenuRef = React.useRef<HTMLDivElement | null>(null);
  const workspaceGroupsRef = React.useRef<HTMLUListElement | null>(null);
  const workspaceDragSessionRef = React.useRef<WorkspaceDragSession | null>(null);
  const suppressWorkspaceClickRef = React.useRef(false);
  const renderCountRef = React.useRef(0);
  renderCountRef.current += 1;

  const query = threadSearch.trim().toLowerCase();
  const [nowMs, setNowMs] = React.useState(Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    return () => {
      workspaceDragSessionRef.current?.cleanup();
    };
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

  const findWorkspaceDragTarget = React.useCallback((clientX: number, clientY: number, draggedWorkspaceId?: string): WorkspaceDragTarget | null => {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
      return null;
    }

    const groupsRect = workspaceGroupsRef.current?.getBoundingClientRect();
    if (
      groupsRect &&
      groupsRect.width > 0 &&
      groupsRect.height > 0 &&
      (clientX < groupsRect.left ||
        clientX > groupsRect.right ||
        clientY < groupsRect.top ||
        clientY > groupsRect.bottom)
    ) {
      return null;
    }

    const findDropElementForWorkspace = (workspaceId: string): HTMLElement | null => {
      return (
        Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-drop-target-id]')).find(
          (candidate) => candidate.dataset.workspaceDropTargetId === workspaceId
        ) ?? null
      );
    };

    const element = document.elementFromPoint(clientX, clientY);
    const workspaceElement = element?.closest('[data-workspace-id]') as HTMLElement | null;
    const workspaceId = workspaceElement?.dataset.workspaceId;
    if (workspaceId && workspaceId !== draggedWorkspaceId) {
      return { element: findDropElementForWorkspace(workspaceId) ?? workspaceElement, workspaceId };
    }

    let nearestTarget: { element: HTMLElement; workspaceId: string; distance: number } | null = null;
    for (const candidate of Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-drop-target-id]'))) {
      const candidateWorkspaceId = candidate.dataset.workspaceDropTargetId;
      if (!candidateWorkspaceId || candidateWorkspaceId === draggedWorkspaceId) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      const distance =
        clientY < rect.top
          ? rect.top - clientY
          : clientY > rect.bottom
            ? clientY - rect.bottom
            : 0;
      const maxDistance = Math.max(48, rect.height * 1.5);
      if (distance > maxDistance) {
        continue;
      }
      if (!nearestTarget || distance < nearestTarget.distance) {
        nearestTarget = {
          element: candidate,
          workspaceId: candidateWorkspaceId,
          distance
        };
      }
    }

    return nearestTarget ? { element: nearestTarget.element, workspaceId: nearestTarget.workspaceId } : null;
  }, []);

  const updateWorkspacePointerDrag = React.useCallback(
    (clientX: number, clientY: number, draggedWorkspaceId: string) => {
      const target = findWorkspaceDragTarget(clientX, clientY, draggedWorkspaceId);
      if (!target || target.workspaceId === draggedWorkspaceId) {
        if (workspaceDragSessionRef.current?.workspaceId === draggedWorkspaceId) {
          workspaceDragSessionRef.current.overWorkspaceId = undefined;
          workspaceDragSessionRef.current.dropPosition = undefined;
        }
        setWorkspaceDragState((current) =>
          current?.draggedWorkspaceId === draggedWorkspaceId &&
          current.overWorkspaceId === undefined &&
          current.dropPosition === undefined
            ? current
            : { draggedWorkspaceId }
        );
        return;
      }

      const dropPosition = resolveWorkspaceDropPositionFromRect(
        clientY,
        target.element.getBoundingClientRect(),
        workspaces,
        draggedWorkspaceId,
        target.workspaceId
      );
      if (workspaceDragSessionRef.current?.workspaceId === draggedWorkspaceId) {
        workspaceDragSessionRef.current.overWorkspaceId = target.workspaceId;
        workspaceDragSessionRef.current.dropPosition = dropPosition;
      }
      setWorkspaceDragState((current) =>
        current?.draggedWorkspaceId === draggedWorkspaceId &&
        current.overWorkspaceId === target.workspaceId &&
        current.dropPosition === dropPosition
          ? current
          : {
              draggedWorkspaceId,
              overWorkspaceId: target.workspaceId,
              dropPosition
            }
      );
    },
    [findWorkspaceDragTarget, workspaces]
  );

  const startWorkspacePointerDrag = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, workspaceId: string) => {
      if (event.isPrimary === false || (typeof event.button === 'number' && event.button > 0) || workspaces.length < 2) {
        return;
      }

      const captureElement = event.currentTarget;
      const pointerId = event.pointerId;
      if (typeof captureElement.setPointerCapture === 'function') {
        try {
          captureElement.setPointerCapture(pointerId);
        } catch {
          // Pointer capture can fail if the pointer already ended; global listeners still handle the drag.
        }
      }
      workspaceDragSessionRef.current?.cleanup();
      let move: (moveEvent: PointerEvent) => void;
      let finish: (finishEvent: PointerEvent) => void;
      let cancel: () => void;
      let onLostPointerCapture: (lostEvent: PointerEvent) => void;
      let onVisibilityChange: () => void;
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('blur', cancel);
        captureElement.removeEventListener('lostpointercapture', onLostPointerCapture);
        document.removeEventListener('mouseleave', cancel);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (
          typeof captureElement.hasPointerCapture === 'function' &&
          typeof captureElement.releasePointerCapture === 'function' &&
          captureElement.hasPointerCapture(pointerId)
        ) {
          captureElement.releasePointerCapture(pointerId);
        }
      };
      move = (moveEvent: PointerEvent) => {
        const session = workspaceDragSessionRef.current;
        if (!session || moveEvent.pointerId !== session.pointerId) {
          return;
        }

        const movementX = moveEvent.clientX - session.startX;
        const movementY = moveEvent.clientY - session.startY;
        const movementDistance = Math.hypot(movementX, movementY);
        if (!session.dragging) {
          if (movementDistance < 5) {
            return;
          }
          session.dragging = true;
          suppressWorkspaceClickRef.current = true;
          setContextMenu(null);
          setWorkspaceContextMenu(null);
          setNewThreadMenu(null);
          setWorkspaceDragState({ draggedWorkspaceId: session.workspaceId });
        }

        moveEvent.preventDefault();
        updateWorkspacePointerDrag(moveEvent.clientX, moveEvent.clientY, session.workspaceId);
      };
      finish = (finishEvent: PointerEvent) => {
        const session = workspaceDragSessionRef.current;
        if (!session || finishEvent.pointerId !== session.pointerId) {
          return;
        }

        session.cleanup();
        workspaceDragSessionRef.current = null;
        if (!session.dragging) {
          return;
        }

        finishEvent.preventDefault();
        setWorkspaceDragState(null);
        window.setTimeout(() => {
          suppressWorkspaceClickRef.current = false;
        }, 0);

        const target = findWorkspaceDragTarget(finishEvent.clientX, finishEvent.clientY, session.workspaceId);
        if (!target || target.workspaceId === session.workspaceId) {
          return;
        }

        const dropPosition = resolveWorkspaceDropPositionFromRect(
          finishEvent.clientY,
          target.element.getBoundingClientRect(),
          workspaces,
          session.workspaceId,
          target.workspaceId
        );
        const nextWorkspaceOrder = buildDraggedWorkspaceIds(
          workspaces,
          session.workspaceId,
          target.workspaceId,
          dropPosition
        );
        if (!nextWorkspaceOrder) {
          return;
        }
        void onReorderWorkspaces(nextWorkspaceOrder);
      };
      cancel = () => {
        workspaceDragSessionRef.current?.cleanup();
        workspaceDragSessionRef.current = null;
        suppressWorkspaceClickRef.current = false;
        setWorkspaceDragState(null);
      };
      onLostPointerCapture = (lostEvent: PointerEvent) => {
        if (lostEvent.pointerId === pointerId) {
          cancel();
        }
      };
      onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          cancel();
        }
      };

      workspaceDragSessionRef.current = {
        workspaceId,
        pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        cleanup
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('blur', cancel);
      captureElement.addEventListener('lostpointercapture', onLostPointerCapture);
      document.addEventListener('mouseleave', cancel);
      document.addEventListener('visibilitychange', onVisibilityChange);
    },
    [findWorkspaceDragTarget, onReorderWorkspaces, updateWorkspacePointerDrag, workspaces]
  );

  const keyboardReorderWorkspace = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, workspaceId: string) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const currentIndex = workspaces.findIndex((workspace) => workspace.id === workspaceId);
      if (currentIndex < 0) {
        return;
      }

      const targetIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
      const targetWorkspace = workspaces[targetIndex];
      if (!targetWorkspace) {
        return;
      }

      const nextWorkspaceOrder = buildDraggedWorkspaceIds(
        workspaces,
        workspaceId,
        targetWorkspace.id,
        event.key === 'ArrowUp' ? 'before' : 'after'
      );
      if (!nextWorkspaceOrder) {
        return;
      }
      void onReorderWorkspaces(nextWorkspaceOrder);
    },
    [onReorderWorkspaces, workspaces]
  );

  const cancelWorkspacePointerDrag = React.useCallback(() => {
    workspaceDragSessionRef.current?.cleanup();
    workspaceDragSessionRef.current = null;
    suppressWorkspaceClickRef.current = false;
    setWorkspaceDragState(null);
  }, []);

  const contextThreadWorkspace = contextMenu
    ? workspaces.find((workspace) => workspace.id === contextMenu.thread.workspaceId) ?? null
    : null;
  const contextThreadHasSession = Boolean(contextMenu?.thread.claudeSessionId?.trim());
  const contextThreadRemote = contextThreadWorkspace?.kind === 'rdev' || contextThreadWorkspace?.kind === 'ssh';
  const openResumeInTerminalDisabledReason = !contextThreadHasSession
    ? 'No Claude session ID available'
    : contextThreadRemote
      ? 'Open resume in Terminal is only available for local projects. Copy the resume command for remote projects.'
      : null;

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
                  disabled={Boolean(openResumeInTerminalDisabledReason)}
                  title={openResumeInTerminalDisabledReason ?? undefined}
                  onClick={() => {
                    onOpenResumeCommandInTerminal(contextMenu.thread);
                    setContextMenu(null);
                  }}
                >
                  Open in Terminal
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
                    Copy {workspaceContextMenu.workspace.kind === 'rdev' ? 'rdev' : 'SSH'} command
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
                      ? 'Disable git pull on default branch for new threads'
                      : 'Enable git pull on default branch for new threads'}
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
                  {elevatedAccessLabel} thread
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
        <ul className="workspace-groups" ref={workspaceGroupsRef}>
          {workspaces.map((workspace) => {
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
                    isSelectedWorkspace ? 'selected' : '',
                    workspaceDragState?.draggedWorkspaceId === workspace.id ? 'dragging' : '',
                    workspaceDragState?.overWorkspaceId === workspace.id && workspaceDragState.dropPosition
                      ? `drag-over-${workspaceDragState.dropPosition}`
                      : ''
                  ]
                    .filter(Boolean)
                    .join(' ')
                }
                data-expanded={isExpanded ? 'true' : 'false'}
                data-workspace-id={workspace.id}
              >
                <div className="workspace-group-container">
                  <div className="workspace-group-row">
                    {workspaces.length > 1 ? (
                      <button
                        type="button"
                        className="workspace-drag-button"
                        aria-label="Reorder project"
                        aria-describedby={`workspace-name-${workspace.id}`}
                        aria-keyshortcuts="ArrowUp ArrowDown"
                        title={`Drag ${workspace.name} to reorder, or use arrow keys`}
                        data-testid={`workspace-drag-${workspace.id}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          startWorkspacePointerDrag(event, workspace.id);
                        }}
                        onKeyDown={(event) => keyboardReorderWorkspace(event, workspace.id)}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <GripIcon />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="workspace-group-button"
                      data-workspace-drop-target-id={workspace.id}
                      onClick={() => {
                        if (suppressWorkspaceClickRef.current) {
                          suppressWorkspaceClickRef.current = false;
                          return;
                        }
                        setExpandedWorkspaceIds((current) => ({
                          ...current,
                          [workspace.id]: !(current[workspace.id] ?? true)
                        }));
                      }}
                      onPointerDown={(event) => startWorkspacePointerDrag(event, workspace.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        cancelWorkspacePointerDrag();
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
                        <span className="workspace-group-name" id={`workspace-name-${workspace.id}`}>{workspace.name}</span>
                        {isRemoteWorkspace ? <span className="workspace-kind-tag">{workspace.kind}</span> : null}
                        {gitPullEnabled ? (
                          <span
                            className="workspace-git-pull-label"
                            title="Upon new threads, the default branch is checked out and pulled automatically."
                            aria-label="default branch pull enabled for new threads"
                          >
                            default branch pull enabled
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <span className="workspace-group-actions">
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
                          <span>{defaultNewThreadFullAccess ? `New ${elevatedAccessLabelLower} thread` : 'New thread'}</span>
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
                                hasUnreadCompletedTurn={Boolean(unreadCompletedTurnByThread[thread.id])}
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
        <button type="button" className="rail-footer-button" onClick={onOpenSettings}>
          <span className="rail-footer-icon" aria-hidden="true">
            <GearIcon />
          </span>
          <span>Settings</span>
        </button>
      </div>
      {menuLayer}
    </aside>
  );
}

export const LeftRail = React.memo(LeftRailComponent);
