import * as React from 'react';

import type { TerminalSessionStreamState } from '../lib/terminalSessionStream';
import type { Workspace } from '../types';
import { TerminalPanel } from './TerminalPanel';

interface WorkspaceShellDrawerProps {
  open: boolean;
  workspace?: Workspace;
  sessionId?: string | null;
  streamState?: TerminalSessionStreamState | null;
  content?: string;
  height?: number;
  starting?: boolean;
  blockedMessage?: string;
  focusRequestId?: number;
  repairRequestId?: number;
  searchToggleRequestId?: number;
  onClose: () => void;
  onStartResize?: (clientY: number) => void;
  onOpenInTerminal?: () => void;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onFocusChange?: (focused: boolean) => void;
}

function OpenTerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 5.75H6.75A1.75 1.75 0 0 0 5 7.5v9.75A1.75 1.75 0 0 0 6.75 19h9.75A1.75 1.75 0 0 0 18.25 17.25V15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13 5h6v6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m19 5-8.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function WorkspaceShellDrawer({
  open,
  workspace,
  sessionId = null,
  streamState = null,
  content = '',
  height = 280,
  starting = false,
  blockedMessage,
  focusRequestId = 0,
  repairRequestId = 0,
  searchToggleRequestId = 0,
  onClose,
  onStartResize,
  onOpenInTerminal,
  onData,
  onResize,
  onFocusChange
}: WorkspaceShellDrawerProps) {
  if (!open || !workspace) {
    return null;
  }

  return (
    <section className="workspace-shell-drawer" data-testid="workspace-shell-drawer" style={{ height }}>
      <div
        className="workspace-shell-resize-handle"
        data-testid="workspace-shell-resize-handle"
        role="separator"
        aria-label="Resize terminal drawer"
        aria-orientation="horizontal"
        onPointerDown={(event) => {
          if (typeof event.button === 'number' && event.button !== 0) {
            return;
          }
          event.preventDefault();
          onStartResize?.(event.clientY);
        }}
      />
      <div className="workspace-shell-drawer-header">
        <div className="workspace-shell-drawer-title-group">
          <strong>Terminal</strong>
          <span>{workspace.name}</span>
        </div>
        <div className="workspace-shell-drawer-actions">
          <button
            type="button"
            className="workspace-shell-drawer-action"
            data-testid="workspace-shell-open-terminal"
            aria-label="Open in Terminal"
            title="Open in Terminal"
            onClick={onOpenInTerminal}
          >
            <OpenTerminalIcon />
          </button>
          <button
            type="button"
            className="workspace-shell-drawer-close"
            aria-label="Close terminal drawer"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="workspace-shell-drawer-body">
        <TerminalPanel
          sessionId={sessionId}
          streamState={streamState}
          content={content}
          inputEnabled={Boolean(sessionId) && !starting && !blockedMessage}
          overlayMessage={
            blockedMessage
              ? blockedMessage
              : starting
              ? 'Starting terminal...'
              : !sessionId
                ? 'Terminal ended. Use the Terminal button to reopen.'
                : undefined
          }
          focusRequestId={focusRequestId}
          repairRequestId={repairRequestId}
          searchToggleRequestId={searchToggleRequestId}
          onData={onData}
          onResize={onResize}
          onFocusChange={onFocusChange}
        />
      </div>
    </section>
  );
}
