import { useEffect, useState } from 'react';

import { AppIcon } from './AppIcon';

interface CloneRepositoryDialogProps {
  open: boolean;
  destinationParent: string;
  busy: boolean;
  error?: string | null;
  onChooseDestination: () => void;
  onClone: (repository: string) => void;
  onClose: () => void;
}

export function CloneRepositoryDialog({
  open,
  destinationParent,
  busy,
  error,
  onChooseDestination,
  onClone,
  onClose
}: CloneRepositoryDialogProps) {
  const [repository, setRepository] = useState('');

  useEffect(() => {
    if (open) setRepository('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy, onClose, open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onPointerDown={() => !busy && onClose()}>
      <form
        className="project-form-dialog clone-repository-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clone-repository-title"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (repository.trim() && destinationParent) onClone(repository.trim());
        }}
      >
        <header>
          <div>
            <h2 id="clone-repository-title">Clone repository</h2>
            <p>Clone a Git repository and add the resulting local folder as an ATController project.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={busy}>
            <AppIcon name="close" />
          </button>
        </header>
        <label>
          <span>Repository URL or local path</span>
          <input
            autoFocus
            value={repository}
            placeholder="https://github.com/owner/repository.git"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setRepository(event.target.value)}
          />
        </label>
        <label>
          <span>Clone into</span>
          <button
            type="button"
            className="folder-location-button"
            onClick={onChooseDestination}
            disabled={busy}
          >
            <AppIcon name="folder" />
            <span title={destinationParent}>
              {destinationParent || 'Choose a destination folder…'}
            </span>
          </button>
        </label>
        {error ? <div className="inline-dialog-error"><AppIcon name="warning" /><span>{error}</span></div> : null}
        <footer>
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={!repository.trim() || !destinationParent || busy}>
            {busy ? 'Cloning…' : 'Clone and Add'}
          </button>
        </footer>
      </form>
    </div>
  );
}
