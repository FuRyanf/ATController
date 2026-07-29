import { useEffect, useMemo, useState } from 'react';

import type { CodexDiscoveredProject } from '../types';
import { AppIcon } from './AppIcon';

interface ProjectImportDialogProps {
  open: boolean;
  projects: CodexDiscoveredProject[];
  loading: boolean;
  busy: boolean;
  error?: string | null;
  onRefresh: () => void;
  onImport: (workspacePaths: string[]) => void;
  onClose: () => void;
}

function activityLabel(timestamp?: number | null): string {
  if (!timestamp) return 'Unknown activity';
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(milliseconds).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function ProjectImportDialog({
  open,
  projects,
  loading,
  busy,
  error,
  onRefresh,
  onImport,
  onClose
}: ProjectImportDialogProps) {
  const eligible = useMemo(
    () => projects.filter((project) => project.available && !project.alreadyAdded),
    [projects]
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(eligible.map((project) => project.workspacePath)));
  }, [open, eligible.map((project) => project.workspacePath).join('\n')]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy, onClose, open]);

  if (!open) return null;

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="modal-backdrop" onPointerDown={() => !busy && onClose()}>
      <section
        className="project-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-projects-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="import-projects-title">Import existing Codex projects</h2>
            <p>
              ATController found workspace paths in the official Codex thread history.
              Thread transcripts remain managed by Codex.
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={busy}>
            <AppIcon name="close" />
          </button>
        </header>

        <div className="project-import-toolbar">
          <button
            type="button"
            className="text-button"
            disabled={!eligible.length}
            onClick={() => setSelected(new Set(eligible.map((project) => project.workspacePath)))}
          >
            Select all available
          </button>
          <button type="button" className="text-button" disabled={!selected.size} onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button type="button" className="icon-button" aria-label="Scan again" title="Scan again" onClick={onRefresh} disabled={loading || busy}>
            <AppIcon name="refresh" />
          </button>
        </div>

        <div className="project-import-list">
          {loading ? (
            <div className="dialog-loading"><span />Reading Codex thread history…</div>
          ) : error ? (
            <div className="dialog-error">
              <AppIcon name="warning" />
              <div><strong>Couldn’t inspect Codex history</strong><span>{error}</span></div>
              <button type="button" onClick={onRefresh}>Try again</button>
            </div>
          ) : projects.length === 0 ? (
            <div className="dialog-empty">
              <strong>No additional projects found</strong>
              <span>Codex thread history does not reference another local workspace.</span>
            </div>
          ) : (
            projects.map((project) => {
              const disabled = project.alreadyAdded || !project.available || busy;
              return (
                <label
                  key={project.workspacePath}
                  className={`project-import-row ${disabled ? 'disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(project.workspacePath)}
                    disabled={disabled}
                    onChange={() => toggle(project.workspacePath)}
                  />
                  <span className="project-import-monogram" aria-hidden="true">
                    {project.name.slice(0, 2).toLocaleUpperCase()}
                  </span>
                  <span className="project-import-copy">
                    <span>
                      <strong>{project.name}</strong>
                      {project.alreadyAdded ? <em>Already added</em> : null}
                      {!project.available ? <em className="warning">Folder unavailable</em> : null}
                    </span>
                    <span title={project.workspacePath}>{project.workspacePath}</span>
                  </span>
                  <span className="project-import-stats">
                    <strong>{project.threadCount}</strong>
                    <span>{project.threadCount === 1 ? 'thread' : 'threads'}</span>
                    <small>{activityLabel(project.mostRecentActivity)}</small>
                  </span>
                </label>
              );
            })
          )}
        </div>

        <footer>
          <span>
            {selected.size
              ? `${selected.size} ${selected.size === 1 ? 'project' : 'projects'} selected`
              : 'Select at least one available project'}
          </span>
          <div>
            <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              type="button"
              className="primary-button"
              disabled={!selected.size || busy}
              onClick={() => onImport([...selected])}
            >
              {busy ? 'Importing…' : 'Import Projects'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
