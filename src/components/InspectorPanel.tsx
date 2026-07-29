import { useMemo, useState } from 'react';

import type {
  CodexDiagnostics,
  CodexFileChange,
  CodexThread,
  CodexThreadSession,
  CodexThreadUiMetadata,
  GitBranchEntry,
  GitChangedFile,
  GitInfo,
  GitWorkspaceStatus
} from '../types';
import { AppIcon } from './AppIcon';

type InspectorTab = 'changes' | 'commands' | 'thread' | 'runtime';

interface InspectorPanelProps {
  thread: CodexThread;
  session?: CodexThreadSession;
  metadata?: CodexThreadUiMetadata;
  diagnostics: CodexDiagnostics | null;
  gitInfo: GitInfo | null;
  gitStatus: GitWorkspaceStatus | null;
  gitBranches: GitBranchEntry[];
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
  onOpenFile: (path: string) => void;
  onRevealFile: (path: string) => void;
  onLoadDiff: (path: string) => Promise<string>;
  onRevertFile: (path: string) => void;
  onSwitchBranch: (branch: string) => void;
  onCreateBranch: (branch: string) => void;
  onCopyPatch: () => void;
  onCopyResume: (fullAccess: boolean) => void;
  onOpenResumeInTerminal: () => void;
  onOpenTerminal: (path: string) => void;
  onRestartRuntime: () => void;
}

function allFileChanges(thread: CodexThread): CodexFileChange[] {
  const latest = new Map<string, CodexFileChange>();
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      for (const change of item.changes) {
        latest.set(change.path, change);
      }
    }
  }
  return [...latest.values()];
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000).toLocaleString();
}

export function InspectorPanel({
  thread,
  session,
  metadata,
  diagnostics,
  gitInfo,
  gitStatus,
  gitBranches,
  onClose,
  onCopy,
  onOpenFile,
  onRevealFile,
  onLoadDiff,
  onRevertFile,
  onSwitchBranch,
  onCreateBranch,
  onCopyPatch,
  onCopyResume,
  onOpenResumeInTerminal,
  onOpenTerminal,
  onRestartRuntime
}: InspectorPanelProps) {
  const [tab, setTab] = useState<InspectorTab>('changes');
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [diffError, setDiffError] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const changes = useMemo(() => allFileChanges(thread), [thread]);
  const workingFiles = useMemo<GitChangedFile[]>(
    () =>
      gitStatus
        ? gitStatus.files
        : changes.map((change) => ({
            path: change.path,
            status: change.kind || 'modified',
            staged: false,
            insertions: 0,
            deletions: 0,
            binary: false
          })),
    [changes, gitStatus]
  );
  const commands = useMemo(
    () => thread.turns.flatMap((turn) => turn.items.filter((item) => item.kind === 'commandExecution')),
    [thread]
  );

  return (
    <aside className="inspector-panel">
      <header className="inspector-header">
        <nav aria-label="Inspector">
          {(['changes', 'commands', 'thread', 'runtime'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={tab === candidate ? 'active' : ''}
              onClick={() => setTab(candidate)}
            >
              {candidate}
              {candidate === 'changes' && workingFiles.length ? <span>{workingFiles.length}</span> : null}
              {candidate === 'commands' && commands.length ? <span>{commands.length}</span> : null}
            </button>
          ))}
        </nav>
        <button type="button" className="icon-button subtle" aria-label="Close inspector" onClick={onClose}>
          <AppIcon name="close" />
        </button>
      </header>

      <div className="inspector-content">
        {tab === 'changes' ? (
          <>
            <section className="inspector-summary">
              <div>
                <strong>{gitStatus?.uncommittedFiles ?? workingFiles.length}</strong>
                <span>changed files</span>
              </div>
              <div>
                <strong className="added">+{gitStatus?.insertions ?? 0}</strong>
                <span>added</span>
              </div>
              <div>
                <strong className="removed">−{gitStatus?.deletions ?? 0}</strong>
                <span>removed</span>
              </div>
            </section>
            {gitInfo ? (
              <section className="inspector-git-controls">
                <label>
                  <span>Branch</span>
                  <select
                    value={gitInfo.branch}
                    disabled={Boolean(gitStatus?.isDirty)}
                    title={gitStatus?.isDirty ? 'Commit or revert changes before switching branches' : 'Switch branch'}
                    onChange={(event) => onSwitchBranch(event.target.value)}
                  >
                    {gitBranches.map((branch) => (
                      <option key={branch.name} value={branch.name}>{branch.name}</option>
                    ))}
                  </select>
                </label>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newBranch.trim()) return;
                    onCreateBranch(newBranch);
                    setNewBranch('');
                  }}
                >
                  <input
                    value={newBranch}
                    disabled={Boolean(gitStatus?.isDirty)}
                    placeholder="New branch"
                    aria-label="New branch name"
                    onChange={(event) => setNewBranch(event.target.value)}
                  />
                  <button type="submit" disabled={!newBranch.trim() || Boolean(gitStatus?.isDirty)}>Create</button>
                </form>
                <button type="button" disabled={!workingFiles.length} onClick={onCopyPatch}>
                  <AppIcon name="copy" />
                  Copy working tree patch
                </button>
                {gitStatus?.isDirty ? (
                  <p>Branch changes are locked while the working tree is dirty.</p>
                ) : null}
              </section>
            ) : null}
            {workingFiles.length === 0 ? (
              <div className="inspector-empty">
                <AppIcon name="file" size={22} />
                <strong>No file changes yet</strong>
                <p>Edits made by Codex will appear here as they happen.</p>
              </div>
            ) : (
              <div className="inspector-list">
                {workingFiles.map((change) => {
                  const expanded = expandedPath === change.path;
                  return (
                    <article className={`inspector-file ${expanded ? 'expanded' : ''}`} key={change.path}>
                      <button
                        className="inspector-file-row"
                        type="button"
                        onClick={() => {
                          if (expanded) {
                            setExpandedPath(null);
                            return;
                          }
                          setExpandedPath(change.path);
                          setDiff('');
                          setDiffError('');
                          setLoadingDiff(true);
                          void onLoadDiff(change.path)
                            .then(setDiff)
                            .catch((error) => setDiffError(String(error)))
                            .finally(() => setLoadingDiff(false));
                        }}
                      >
                        <AppIcon name="file" />
                        <span><strong>{change.path.split('/').pop()}</strong><small>{change.path}</small></span>
                        <span className="inspector-file-counts">
                          {change.insertions ? <i className="added">+{change.insertions}</i> : null}
                          {change.deletions ? <i className="removed">−{change.deletions}</i> : null}
                          <em>{change.status}</em>
                        </span>
                      </button>
                      {expanded ? (
                        <div className="inspector-file-detail">
                          {loadingDiff ? <p className="muted">Loading diff…</p> : null}
                          {diffError ? <p className="timeline-error">{diffError}</p> : null}
                          {diff ? <pre className="inspector-diff">{diff}</pre> : !loadingDiff && !diffError ? <p className="muted">No textual diff is available.</p> : null}
                          <footer>
                            <button type="button" onClick={() => onOpenFile(change.path)}>Open file</button>
                            <button type="button" onClick={() => onRevealFile(change.path)}>Reveal</button>
                            <button type="button" onClick={() => onCopy(change.path, 'File path')}>Copy path</button>
                            {diff ? <button type="button" onClick={() => onCopy(diff, 'Patch')}>Copy patch</button> : null}
                            <button type="button" className="danger-action" onClick={() => onRevertFile(change.path)}>Revert</button>
                          </footer>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </>
        ) : null}

        {tab === 'commands' ? (
          commands.length === 0 ? (
            <div className="inspector-empty">
              <AppIcon name="terminal" size={22} />
              <strong>No command history</strong>
              <p>Commands executed by Codex will appear here.</p>
            </div>
          ) : (
            <div className="inspector-command-list">
              {commands.map((command) => (
                <article key={command.id}>
                  <header>
                    <span className={`command-state ${command.status === 'inProgress' ? 'running' : command.exitCode === 0 ? 'success' : 'failed'}`} />
                    <code>{command.command}</code>
                  </header>
                  <footer>
                    <span>{command.cwd}</span>
                    <button type="button" onClick={() => onCopy(command.command ?? '', 'Command')}>Copy</button>
                    {command.cwd ? <button type="button" onClick={() => onOpenTerminal(command.cwd!)}>Terminal</button> : null}
                  </footer>
                </article>
              ))}
            </div>
          )
        ) : null}

        {tab === 'thread' ? (
          <div className="inspector-details">
            <section>
              <h3>Thread</h3>
              <dl>
                <div><dt>Identifier</dt><dd><code>{thread.id}</code><button type="button" onClick={() => onCopy(thread.id, 'Thread ID')}><AppIcon name="copy" /></button></dd></div>
                <div><dt>Workspace</dt><dd>{thread.cwd}</dd></div>
                <div><dt>Created</dt><dd>{formatTimestamp(thread.createdAt)}</dd></div>
                <div><dt>Updated</dt><dd>{formatTimestamp(thread.recencyAt ?? thread.updatedAt)}</dd></div>
                <div><dt>Source</dt><dd>{thread.source}</dd></div>
                <div><dt>CLI version</dt><dd>{thread.cliVersion || 'Current runtime'}</dd></div>
              </dl>
            </section>
            <section>
              <h3>Session</h3>
              <dl>
                <div><dt>Model</dt><dd>{session?.settings.effectiveModel ?? metadata?.requestedModel ?? 'Runtime default'}</dd></div>
                <div><dt>Reasoning</dt><dd>{session?.settings.effectiveReasoningEffort ?? metadata?.requestedReasoningEffort ?? 'Runtime default'}</dd></div>
                <div><dt>Service tier</dt><dd>{session?.settings.effectiveServiceTier ?? metadata?.requestedServiceTier ?? 'Runtime default'}</dd></div>
                <div><dt>Permissions</dt><dd>{session?.settings.permissionMode ?? metadata?.permissionMode ?? 'fullAccess'}</dd></div>
                <div><dt>Approval policy</dt><dd>{session?.settings.approvalPolicy ?? 'Runtime default'}</dd></div>
                <div><dt>Sandbox</dt><dd>{session?.settings.sandboxPolicy ?? 'Runtime default'}</dd></div>
              </dl>
            </section>
            <section className="inspector-button-stack">
              <button type="button" onClick={() => onCopy(thread.id, 'Thread ID')}><AppIcon name="copy" />Copy thread ID</button>
              <button type="button" onClick={() => onCopyResume(false)}><AppIcon name="copy" />Copy resume command</button>
              <button type="button" onClick={() => onCopyResume(true)}><AppIcon name="copy" />Copy Full Access resume command</button>
              <button type="button" onClick={onOpenResumeInTerminal}><AppIcon name="terminal" />Open resume command in Terminal</button>
              <button type="button" onClick={() => onOpenTerminal(thread.cwd)}><AppIcon name="terminal" />Open project in Terminal</button>
            </section>
          </div>
        ) : null}

        {tab === 'runtime' ? (
          <div className="inspector-details">
            <section className="runtime-health">
              <span className={`runtime-dot ${diagnostics?.connectionState ?? 'stopped'}`} />
              <div>
                <strong>{diagnostics?.connectionState ?? 'Unavailable'}</strong>
                <p>{diagnostics?.initialized ? 'Structured app-server connection initialized' : 'Waiting for initialization'}</p>
              </div>
            </section>
            <section>
              <h3>Codex runtime</h3>
              <dl>
                <div><dt>Version</dt><dd>{diagnostics?.codexVersion ?? 'Unknown'}</dd></div>
                <div><dt>Binary</dt><dd className="break-path">{diagnostics?.codexBinaryPath ?? 'Not discovered'}</dd></div>
                <div><dt>Transport</dt><dd>{diagnostics?.transport ?? 'stdio'}</dd></div>
                <div><dt>Process</dt><dd>{diagnostics?.processId ?? 'Not running'}</dd></div>
                <div><dt>Pending RPC</dt><dd>{diagnostics?.pendingRequests ?? 0}</dd></div>
                <div><dt>Event queue</dt><dd>{diagnostics?.eventQueueDepth ?? 0}</dd></div>
                <div><dt>Branch</dt><dd>{gitInfo?.branch ?? 'Not a Git repository'}</dd></div>
              </dl>
            </section>
            <section className="inspector-button-stack">
              <button type="button" onClick={onRestartRuntime}><AppIcon name="refresh" />Restart Codex runtime</button>
            </section>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
