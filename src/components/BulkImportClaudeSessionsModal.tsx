import { useEffect, useMemo, useState } from 'react';

import type { ImportableClaudeProject, ImportableClaudeSession } from '../types';

interface BulkImportClaudeSessionsModalProps {
  open: boolean;
  loading?: boolean;
  importing?: boolean;
  projects: ImportableClaudeProject[];
  selectedSessionIds: string[];
  alreadyImportedSessionIds: string[];
  error?: string | null;
  onClose: () => void;
  onToggleSession: (sessionId: string, selected: boolean) => void;
  onToggleProject: (
    project: ImportableClaudeProject,
    visibleImportableSessionIds: string[],
    selected: boolean
  ) => void;
  onImport: () => void;
}

function projectStatusLabel(project: ImportableClaudeProject) {
  if (!project.pathExists) {
    return 'Folder missing';
  }
  if (project.workspaceId) {
    return 'Project already added';
  }
  return 'Will add project';
}

function sessionTitle(session: ImportableClaudeSession) {
  return session.summary?.trim() || session.firstPrompt?.trim() || 'Untitled Claude session';
}

function sessionSubtitle(session: ImportableClaudeSession) {
  const firstPrompt = session.firstPrompt?.trim();
  const summary = session.summary?.trim();
  if (!firstPrompt || firstPrompt === summary) {
    return null;
  }
  return firstPrompt;
}

function formatTimestamp(value?: string | null) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp);
}

function sessionTimestampMs(session: ImportableClaudeSession) {
  const modifiedAtMs = session.modifiedAt ? Date.parse(session.modifiedAt) : Number.NaN;
  if (Number.isFinite(modifiedAtMs)) {
    return modifiedAtMs;
  }

  const createdAtMs = session.createdAt ? Date.parse(session.createdAt) : Number.NaN;
  if (Number.isFinite(createdAtMs)) {
    return createdAtMs;
  }

  return null;
}

function sessionMatchesTimeRange(session: ImportableClaudeSession, earliestSessionMs: number | null) {
  if (earliestSessionMs === null) {
    return true;
  }

  const timestampMs = sessionTimestampMs(session);
  return timestampMs === null || timestampMs >= earliestSessionMs;
}

function visibleProjectSessions(
  project: ImportableClaudeProject,
  importedSet: ReadonlySet<string>,
  includeAlreadyImported: boolean,
  earliestSessionMs: number | null
) {
  return project.sessions.filter((session) => {
    if (!includeAlreadyImported && importedSet.has(session.sessionId)) {
      return false;
    }

    return sessionMatchesTimeRange(session, earliestSessionMs);
  });
}

function visibleImportableSessionIds(
  sessions: ImportableClaudeSession[],
  importedSet: ReadonlySet<string>
) {
  return sessions
    .filter((session) => !importedSet.has(session.sessionId))
    .map((session) => session.sessionId);
}

function projectListKey(project: ImportableClaudeProject) {
  const firstSessionId = project.sessions[0]?.sessionId ?? '';
  const lastSessionId = project.sessions[project.sessions.length - 1]?.sessionId ?? '';
  return [
    project.path,
    project.workspaceId ?? '',
    project.workspaceName ?? '',
    String(project.sessions.length),
    firstSessionId,
    lastSessionId
  ].join('::');
}

export function BulkImportClaudeSessionsModal({
  open,
  loading = false,
  importing = false,
  projects,
  selectedSessionIds,
  alreadyImportedSessionIds,
  error,
  onClose,
  onToggleSession,
  onToggleProject,
  onImport
}: BulkImportClaudeSessionsModalProps) {
  const selectedSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds]);
  const importedSet = useMemo(() => new Set(alreadyImportedSessionIds), [alreadyImportedSessionIds]);
  const selectedCount = selectedSessionIds.length;
  const [searchQuery, setSearchQuery] = useState('');
  const [includeAlreadyImported, setIncludeAlreadyImported] = useState(false);
  const [daysBackInput, setDaysBackInput] = useState('30');

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setIncludeAlreadyImported(false);
      setDaysBackInput('30');
    }
  }, [open]);

  const daysBack = useMemo(() => {
    const trimmed = daysBackInput.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return Math.floor(parsed);
  }, [daysBackInput]);

  const earliestSessionMs = useMemo(() => {
    if (daysBack === null) {
      return null;
    }
    return Date.now() - daysBack * 24 * 60 * 60 * 1000;
  }, [daysBack]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return projects.flatMap((project) => {
      if (!project.pathExists) {
        return [];
      }

      const matchesQuery =
        !query || project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query);
      if (!matchesQuery) {
        return [];
      }

      const visibleSessions = visibleProjectSessions(project, importedSet, includeAlreadyImported, earliestSessionMs);
      const sessionsInTimeRange = project.sessions.filter((session) => sessionMatchesTimeRange(session, earliestSessionMs));
      const allThreadsImported =
        sessionsInTimeRange.length > 0 && sessionsInTimeRange.every((session) => importedSet.has(session.sessionId));
      if (!includeAlreadyImported) {
        return visibleSessions.length > 0 || query
          ? [
              {
                project,
                visibleSessions,
                allThreadsImported
              }
            ]
          : [];
      }

      return [{ project, visibleSessions, allThreadsImported: false }];
    });
  }, [earliestSessionMs, importedSet, includeAlreadyImported, projects, searchQuery]);

  const emptyStateMessage = useMemo(() => {
    if (searchQuery.trim()) {
      return 'No projects match the current filters.';
    }
    if (!includeAlreadyImported) {
      return daysBack === null
        ? 'No importable projects are visible. Turn on "Include already imported" to show previously imported sessions.'
        : `No importable projects are visible in the past ${daysBack} day${daysBack === 1 ? '' : 's'}. Turn on "Include already imported" or widen the range.`;
    }
    if (daysBack !== null) {
      return `No projects have visible sessions in the past ${daysBack} day${daysBack === 1 ? '' : 's'}.`;
    }
    return 'No projects are available to import.';
  }, [daysBack, includeAlreadyImported, searchQuery]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal bulk-import-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-import-title">
        <header className="bulk-import-modal-header">
          <div>
            <h2 id="bulk-import-title">Bulk Import Claude Sessions</h2>
            <p>Discover Claude’s local session history, pick the conversations you want, and import them as threads.</p>
          </div>
        </header>

        <div className="bulk-import-toolbar">
          <div className="bulk-import-toolbar-main">
            <div className="bulk-import-search codex-thread-search">
              <span className="search-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M16 16l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Filter projects by name or path"
                aria-label="Filter projects by name or path"
              />
            </div>
            <div className="bulk-import-filter-toggles">
              <label className="bulk-import-days-filter">
                <span>Past</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={daysBackInput}
                  onChange={(event) => setDaysBackInput(event.target.value)}
                  aria-label="Days of session history to show; leave blank for all time"
                />
                <span>days</span>
              </label>
              <button
                type="button"
                className={includeAlreadyImported ? 'settings-switch active' : 'settings-switch'}
                aria-pressed={includeAlreadyImported}
                onClick={() => setIncludeAlreadyImported((current) => !current)}
              >
                <span className="settings-switch-track" aria-hidden="true">
                  <span className="settings-switch-thumb" />
                </span>
                <span className="settings-switch-label">Include already imported</span>
              </button>
            </div>
          </div>
          <p className="muted">
            {selectedCount === 0 ? 'No sessions selected.' : `${selectedCount} session${selectedCount === 1 ? '' : 's'} selected.`}
          </p>
        </div>

        {error ? <p className="modal-error">{error}</p> : null}

        {loading ? <div className="bulk-import-empty">Scanning Claude session history…</div> : null}

        {!loading && projects.length === 0 ? (
          <div className="bulk-import-empty">
            No Claude sessions were found under <code>~/.claude/projects</code>.
          </div>
        ) : null}

        {!loading && projects.length > 0 ? (
          <div className="bulk-import-project-list">
            {filteredProjects.length === 0 ? (
              <div className="bulk-import-empty">{emptyStateMessage}</div>
            ) : null}
            {filteredProjects.map(({ project, visibleSessions, allThreadsImported }) => {
              const importableSessionIds = visibleImportableSessionIds(visibleSessions, importedSet);
              const selectedInProject = importableSessionIds.filter((sessionId) => selectedSet.has(sessionId)).length;
              const allSelected = importableSessionIds.length > 0 && selectedInProject === importableSessionIds.length;

              return (
                <section key={projectListKey(project)} className="bulk-import-project">
                  <header className="bulk-import-project-header">
                    <div className="bulk-import-project-copy">
                      <div className="bulk-import-project-title-row">
                        <h3>{project.name}</h3>
                        <span className={project.pathExists ? 'bulk-import-project-status' : 'bulk-import-project-status warning'}>
                          {projectStatusLabel(project)}
                        </span>
                      </div>
                      <p className="bulk-import-project-path">{project.path}</p>
                      {project.workspaceName ? (
                        <p className="bulk-import-project-helper">Imports into {project.workspaceName}.</p>
                      ) : (
                        <p className="bulk-import-project-helper">Imports will add this project first.</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ghost-button settings-inline-button"
                      onClick={() => onToggleProject(project, importableSessionIds, !allSelected)}
                      disabled={importing || importableSessionIds.length === 0}
                    >
                      {allSelected ? 'Clear' : 'Select all'}
                    </button>
                  </header>

                  <div className="bulk-import-session-list">
                    {allThreadsImported ? (
                      <div className="bulk-import-project-empty">All threads are already imported.</div>
                    ) : visibleSessions.length === 0 ? (
                      <div className="bulk-import-project-empty">
                        {daysBack === null
                          ? 'No sessions are visible for this project.'
                          : `No sessions are visible in the past ${daysBack} day${daysBack === 1 ? '' : 's'}.`}
                      </div>
                    ) : null}
                    {visibleSessions.map((session) => {
                      const alreadyImported = importedSet.has(session.sessionId);
                      const disabled = importing || !project.pathExists || alreadyImported;
                      const subtitle = sessionSubtitle(session);
                      const timestamp = formatTimestamp(session.modifiedAt ?? session.createdAt);

                      return (
                        <label
                          key={session.sessionId}
                          className={
                            disabled
                              ? 'bulk-import-session-row disabled'
                              : selectedSet.has(session.sessionId)
                                ? 'bulk-import-session-row selected'
                                : 'bulk-import-session-row'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={selectedSet.has(session.sessionId)}
                            disabled={disabled}
                            onChange={(event) => onToggleSession(session.sessionId, event.target.checked)}
                          />
                          <div className="bulk-import-session-copy">
                            <div className="bulk-import-session-heading">
                              <strong>{sessionTitle(session)}</strong>
                              {timestamp ? <span>{timestamp}</span> : null}
                            </div>
                            {subtitle ? <p className="bulk-import-session-subtitle">{subtitle}</p> : null}
                            <div className="bulk-import-session-meta">
                              <code>{session.sessionId}</code>
                              {session.gitBranch ? <span>{session.gitBranch}</span> : null}
                              {session.messageCount > 0 ? <span>{session.messageCount} msgs</span> : null}
                              {alreadyImported ? <span>Already imported</span> : null}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}

        <footer className="modal-actions bulk-import-modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onImport}
            disabled={importing || selectedCount === 0}
          >
            {importing
              ? 'Importing…'
              : selectedCount === 0
                ? 'Import selected'
                : `Import selected (${selectedCount})`}
          </button>
        </footer>
      </section>
    </div>
  );
}
