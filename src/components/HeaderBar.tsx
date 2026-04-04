import * as React from 'react';
import type { GitInfo, ThreadMetadata, Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  selectedThread?: ThreadMetadata;
  gitInfo?: GitInfo | null;
  updateAvailable?: boolean;
  updateVersionLabel?: string;
  updating?: boolean;
  onInstallUpdate: () => void;
  onOpenWorkspace: () => void;
  onOpenTerminal: () => void;
  terminalOpen?: boolean;
}

export function HeaderBar({
  workspace,
  selectedThread,
  gitInfo = null,
  updateAvailable = false,
  updateVersionLabel,
  updating = false,
  onInstallUpdate,
  onOpenWorkspace,
  onOpenTerminal,
  terminalOpen = false
}: HeaderBarProps) {
  return (
    <header className="header-bar" data-testid="header">
      <div className={selectedThread ? 'workspace-summary thread-context' : 'workspace-summary'}>
        <strong>{selectedThread?.title ?? workspace?.name ?? 'No workspace selected'}</strong>
        {workspace ? (
          <span className="workspace-summary-secondary">
            {selectedThread ? workspace.name : workspace.path}
            {gitInfo?.branch ? <span className="header-branch-pill">{gitInfo.branch}</span> : null}
          </span>
        ) : null}
      </div>

      <div className="header-actions">
        {updateAvailable ? (
          <button
            type="button"
            onClick={onInstallUpdate}
            className="update-button"
            disabled={updating}
            title={updateVersionLabel ? `Update to ${updateVersionLabel}` : 'Update available'}
          >
            {updating ? 'Updating…' : 'Update'}
          </button>
        ) : null}
        <button type="button" onClick={onOpenWorkspace} className="ghost-button" disabled={!workspace}>
          Open
        </button>
        <button
          type="button"
          onClick={onOpenTerminal}
          className={terminalOpen ? 'ghost-button active' : 'ghost-button'}
          disabled={!workspace}
        >
          Terminal
        </button>
      </div>
    </header>
  );
}
