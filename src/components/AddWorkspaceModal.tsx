import { useEffect, useState } from 'react';

type AddWorkspaceMode = 'local' | 'ssh';

interface AddWorkspaceModalProps {
  open: boolean;
  initialPath?: string;
  initialSshCommand?: string;
  initialSshRemotePath?: string;
  initialDisplayName?: string;
  initialMode?: AddWorkspaceMode;
  error?: string | null;
  saving?: boolean;
  onClose: () => void;
  onConfirmLocal: (path: string) => void;
  onConfirmSsh: (sshCommand: string, displayName: string, remotePath: string) => void;
  onPickDirectory: () => void;
  onOpenBulkImport?: () => void;
}

export function AddWorkspaceModal({
  open,
  initialPath = '',
  initialSshCommand = '',
  initialSshRemotePath = '',
  initialDisplayName = '',
  initialMode = 'local',
  error,
  saving,
  onClose,
  onConfirmLocal,
  onConfirmSsh,
  onPickDirectory,
  onOpenBulkImport
}: AddWorkspaceModalProps) {
  const [mode, setMode] = useState<AddWorkspaceMode>(initialMode);
  const [path, setPath] = useState(initialPath);
  const [sshCommand, setSshCommand] = useState(initialSshCommand);
  const [sshRemotePath, setSshRemotePath] = useState(initialSshRemotePath);
  const [displayName, setDisplayName] = useState(initialDisplayName);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setPath(initialPath);
      setSshCommand(initialSshCommand);
      setSshRemotePath(initialSshRemotePath);
      setDisplayName(initialDisplayName);
    }
  }, [initialDisplayName, initialMode, initialPath, initialSshCommand, initialSshRemotePath, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal add-workspace-modal">
        <h2>Add Project</h2>

        <div className="add-workspace-mode-toggle" role="tablist" aria-label="Workspace type">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'local'}
            className={mode === 'local' ? 'ghost-button active' : 'ghost-button'}
            onClick={() => setMode('local')}
            disabled={saving}
          >
            Local
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'ssh'}
            className={mode === 'ssh' ? 'ghost-button active' : 'ghost-button'}
            onClick={() => setMode('ssh')}
            disabled={saving}
          >
            SSH
          </button>
        </div>

        {mode === 'local' ? (
          <>
            <p>Pick a folder or paste an absolute path.</p>
            <div className="add-workspace-row">
              <button type="button" className="ghost-button" onClick={onPickDirectory} disabled={saving}>
                Choose Folder
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onOpenBulkImport?.()}
                disabled={saving}
              >
                Import Claude sessions
              </button>
            </div>
            <p className="muted">
              Discover sessions from <code>~/.claude/projects</code> and add missing local projects automatically.
            </p>

            <label htmlFor="workspace-path">Manual path</label>
            <input
              id="workspace-path"
              type="text"
              placeholder="/Users/you/project"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onConfirmLocal(path.trim());
                }
              }}
              autoFocus
            />
          </>
        ) : (
          <>
            <p>Paste an ssh command that authenticates with an SSH key. Claudex does not store credentials.</p>
            <p className="muted">
              Unlock your key with macOS Keychain or <code>ssh-agent</code>, and verify{' '}
              <code>ssh user@host</code> works in Terminal before adding the project.
            </p>
            <p className="muted">
              Recommended <code>~/.ssh/config</code>: <code>AddKeysToAgent yes</code>{' '}
              <code>UseKeychain yes</code>
            </p>
            <label htmlFor="workspace-ssh-command">ssh command</label>
            <input
              id="workspace-ssh-command"
              type="text"
              placeholder="ssh dev@remote-host"
              value={sshCommand}
              onChange={(event) => setSshCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onConfirmSsh(sshCommand.trim(), displayName.trim(), sshRemotePath.trim());
                }
              }}
              autoFocus
            />

            <label htmlFor="workspace-ssh-name">Display name (optional)</label>
            <input
              id="workspace-ssh-name"
              type="text"
              placeholder="remote-host"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />

            <label htmlFor="workspace-ssh-remote-path">Remote path (optional)</label>
            <input
              id="workspace-ssh-remote-path"
              type="text"
              placeholder="~/projects/my-repo"
              value={sshRemotePath}
              onChange={(event) => setSshRemotePath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onConfirmSsh(sshCommand.trim(), displayName.trim(), sshRemotePath.trim());
                }
              }}
            />
          </>
        )}

        {error ? <p className="modal-error">{error}</p> : null}

        <footer className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              if (mode === 'local') {
                onConfirmLocal(path.trim());
                return;
              }
              onConfirmSsh(sshCommand.trim(), displayName.trim(), sshRemotePath.trim());
            }}
            disabled={saving || (mode === 'local' ? !path.trim() : !sshCommand.trim())}
          >
            {saving ? 'Adding...' : mode === 'local' ? 'Add project' : 'Add SSH project'}
          </button>
        </footer>
      </section>
    </div>
  );
}
