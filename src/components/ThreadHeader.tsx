import { memo } from 'react';

import type {
  BrowserAction,
  BrowserDiagnostics,
  BrowserSessionMetadata,
  CodexApprovalRequest,
  CodexThread,
  GitInfo,
  Workspace
} from '../types';
import { AppIcon } from './AppIcon';
import { BrowserMenu } from './BrowserMenu';

interface ThreadHeaderProps {
  thread: CodexThread;
  workspace: Workspace;
  gitInfo: GitInfo | null;
  approvals: CodexApprovalRequest[];
  disconnected: boolean;
  inspectorOpen: boolean;
  browserSession?: BrowserSessionMetadata;
  browserDiagnostics: BrowserDiagnostics | null;
  browserBusy: boolean;
  onRename: () => void;
  onSelectProject: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onToggleInspector: () => void;
  onOpenTerminal: () => void;
  onBrowserAction: (action: BrowserAction) => void;
  onOpenBrowserPage: () => void;
  onCopyBrowserUrl: () => void;
  onOpenBrowserSetup: () => void;
  onOpenBrowserDiagnostics: () => void;
}

function ThreadHeaderComponent({
  thread,
  workspace,
  gitInfo,
  approvals,
  disconnected,
  inspectorOpen,
  browserSession,
  browserDiagnostics,
  browserBusy,
  onRename,
  onSelectProject,
  onOpenMenu,
  onToggleInspector,
  onOpenTerminal,
  onBrowserAction,
  onOpenBrowserPage,
  onCopyBrowserUrl,
  onOpenBrowserSetup,
  onOpenBrowserDiagnostics
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
          <button
            type="button"
            className="thread-project-button"
            title="Reveal project in the sidebar"
            onClick={onSelectProject}
          >
            {workspace.name}
          </button>
          {gitInfo?.branch ? <><span className="metadata-separator">/</span><span>{gitInfo.branch}</span></> : null}
          <span className={`session-status ${status}`}><i />{status}</span>
        </div>
      </div>
      <div className="thread-header-actions">
        <BrowserMenu
          session={browserSession}
          diagnostics={browserDiagnostics}
          busy={browserBusy}
          onAction={onBrowserAction}
          onOpenCurrentPage={onOpenBrowserPage}
          onCopyCurrentUrl={onCopyBrowserUrl}
          onOpenSetup={onOpenBrowserSetup}
          onOpenDiagnostics={onOpenBrowserDiagnostics}
        />
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

export const ThreadHeader = memo(
  ThreadHeaderComponent,
  (previous, next) => {
    const previousLastTurn =
      previous.thread.turns[previous.thread.turns.length - 1];
    const nextLastTurn = next.thread.turns[next.thread.turns.length - 1];
    return (
      previous.thread.id === next.thread.id &&
      previous.thread.title === next.thread.title &&
      previous.thread.archived === next.thread.archived &&
      previousLastTurn?.status === nextLastTurn?.status &&
      previous.workspace.id === next.workspace.id &&
      previous.workspace.name === next.workspace.name &&
      previous.workspace.path === next.workspace.path &&
      previous.gitInfo?.branch === next.gitInfo?.branch &&
      previous.approvals.length === next.approvals.length &&
      previous.disconnected === next.disconnected &&
      previous.inspectorOpen === next.inspectorOpen &&
      previous.browserSession === next.browserSession &&
      previous.browserDiagnostics === next.browserDiagnostics &&
      previous.browserBusy === next.browserBusy
    );
  }
);
