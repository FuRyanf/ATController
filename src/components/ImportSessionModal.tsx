import { useEffect, useRef, useState } from 'react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ImportSessionModalProps {
  open: boolean;
  workspaceName: string;
  error?: string | null;
  saving?: boolean;
  onClose: () => void;
  onConfirm: (claudeSessionId: string) => void;
}

export function ImportSessionModal({
  open,
  workspaceName,
  error,
  saving,
  onClose,
  onConfirm
}: ImportSessionModalProps) {
  const [sessionId, setSessionId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSessionId('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = sessionId.trim();
    if (!trimmed || !UUID_RE.test(trimmed)) {
      return;
    }
    onConfirm(trimmed);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onKeyDown={handleKeyDown}>
      <section className="modal import-session-modal">
        <h2>Import Claude Session</h2>
        <p className="import-session-description">
          Creates a new thread in <strong>{workspaceName}</strong> that resumes an existing Claude conversation.
        </p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="import-session-id">Claude session ID</label>
          <input
            ref={inputRef}
            id="import-session-id"
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="e.g. 01234567-89ab-cdef-0123-456789abcdef"
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
          />
          {error ? <p className="modal-error">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !UUID_RE.test(sessionId.trim())}>
              {saving ? 'Importing…' : 'Import'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
