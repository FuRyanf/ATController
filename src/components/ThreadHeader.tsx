import type {
  CodexApprovalRequest,
  CodexThread,
  CodexThreadSession,
  GitInfo,
  PermissionMode,
  ThreadPreferences,
  Workspace
} from '../types';
import { AppIcon } from './AppIcon';

interface ThreadHeaderProps {
  thread: CodexThread;
  workspace: Workspace;
  session?: CodexThreadSession;
  preferences: ThreadPreferences;
  gitInfo: GitInfo | null;
  approvals: CodexApprovalRequest[];
  disconnected: boolean;
  inspectorOpen: boolean;
  onRename: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onToggleInspector: () => void;
  onOpenTerminal: () => void;
}

function permissionLabel(value?: PermissionMode): string {
  switch (value) {
    case 'standard':
      return 'Standard';
    case 'workspaceAccess':
      return 'Workspace Access';
    case 'fullAccess':
    default:
      return 'Full Access';
  }
}

export function ThreadHeader({
  thread,
  workspace,
  session,
  preferences,
  gitInfo,
  approvals,
  disconnected,
  inspectorOpen,
  onRename,
  onOpenMenu,
  onToggleInspector,
  onOpenTerminal
}: ThreadHeaderProps) {
  const lastTurn = thread.turns.length ? thread.turns[thread.turns.length - 1] : undefined;
  const status = thread.archived
    ? 'archived'
    : disconnected
    ? 'disconnected'
    : approvals.length
      ? 'waiting'
      : lastTurn?.status === 'inProgress'
        ? 'running'
        : lastTurn?.status === 'failed'
          ? 'failed'
          : 'idle';

  return (
    <header className="thread-header">
      <div className="thread-heading">
        <button type="button" className="thread-title-button" title="Rename thread" onDoubleClick={onRename} onClick={onRename}>
          <strong>{thread.title}</strong>
        </button>
        <div className="thread-subtitle">
          <span>{workspace.name}</span>
          {gitInfo?.branch ? <><span className="metadata-separator">/</span><span>{gitInfo.branch}</span></> : null}
          <span className={`session-status ${status}`}><i />{status}</span>
        </div>
      </div>
      <div className="thread-header-metadata">
        <span title={session ? 'Effective model' : 'Requested model'}>
          {session?.settings.effectiveModel ?? preferences.model ?? 'Runtime model'}
        </span>
        <span title={session ? 'Effective reasoning effort' : 'Requested reasoning effort'}>
          {session?.settings.effectiveReasoningEffort ??
            preferences.reasoningEffort ??
            'Default reasoning'}
        </span>
        {session?.settings.effectiveServiceTier ?? preferences.serviceTier ? (
          <span title={session ? 'Effective service tier' : 'Requested service tier'}>
            {session?.settings.effectiveServiceTier ?? preferences.serviceTier}
          </span>
        ) : null}
        <span
          className={
            (session?.settings.permissionMode ?? preferences.permissionMode) === 'fullAccess'
              ? 'full-access-chip'
              : ''
          }
          title="Permission profile"
        >
          {permissionLabel(session?.settings.permissionMode ?? preferences.permissionMode)}
        </span>
      </div>
      <div className="thread-header-actions">
        <button
          type="button"
          className="icon-button"
          aria-label="Open project terminal"
          title="Open Project Terminal (⌘J)"
          onClick={onOpenTerminal}
        >
          <AppIcon name="terminal" />
        </button>
        <button
          type="button"
          className={`icon-button ${inspectorOpen ? 'active' : ''}`}
          aria-label="Toggle inspector"
          title="Toggle inspector (⌘⇧I)"
          onClick={onToggleInspector}
        >
          <AppIcon name="panelRight" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Thread actions"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenMenu(bounds.right, bounds.bottom + 4);
          }}
        >
          <AppIcon name="ellipsis" />
        </button>
      </div>
    </header>
  );
}
