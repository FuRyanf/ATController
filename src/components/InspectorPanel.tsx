import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import { api } from '../lib/api';
import { serviceTierDisplayName } from '../lib/codexLabels';
import type {
  BrowserAction,
  BrowserDiagnostics,
  BrowserSessionMetadata,
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

type InspectorTab = 'changes' | 'commands' | 'browser' | 'thread' | 'runtime';

interface InspectorPanelProps {
  thread: CodexThread;
  workspacePath: string;
  session?: CodexThreadSession;
  metadata?: CodexThreadUiMetadata;
  diagnostics: CodexDiagnostics | null;
  browserSession?: BrowserSessionMetadata;
  browserDiagnostics: BrowserDiagnostics | null;
  browserBusy: boolean;
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
  onBrowserAction: (action: BrowserAction) => void;
  onBrowserSetup: () => void;
  onBrowserDiagnostics: () => void;
  onOpenBrowserPage: () => void;
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

function InspectorPanelComponent({
  thread,
  workspacePath,
  session,
  metadata,
  diagnostics,
  browserSession,
  browserDiagnostics,
  browserBusy,
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
  onRestartRuntime,
  onBrowserAction,
  onBrowserSetup,
  onBrowserDiagnostics,
  onOpenBrowserPage
}: InspectorPanelProps) {
  const [tab, setTab] = useState<InspectorTab>('changes');
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [diffError, setDiffError] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [browserScreenshot, setBrowserScreenshot] = useState('');
  const [browserScreenshotError, setBrowserScreenshotError] = useState('');
  const diffRequestSequence = useRef(0);
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

  useEffect(() => {
    const reference = browserSession?.lastScreenshotReference;
    if (tab !== 'browser' || !reference) {
      setBrowserScreenshot('');
      setBrowserScreenshotError('');
      return;
    }
    let cancelled = false;
    setBrowserScreenshot('');
    setBrowserScreenshotError('');
    void api
      .readBrowserScreenshot(thread.id, reference)
      .then((screenshot) => {
        if (!cancelled) setBrowserScreenshot(screenshot.dataUrl);
      })
      .catch((error) => {
        if (!cancelled) setBrowserScreenshotError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [browserSession?.lastScreenshotReference, tab, thread.id]);

  useLayoutEffect(() => {
    diffRequestSequence.current += 1;
    setExpandedPath(null);
    setDiff('');
    setDiffError('');
    setLoadingDiff(false);
    return () => {
      diffRequestSequence.current += 1;
    };
  }, [thread.id, workspacePath]);

  return (
    <aside className="inspector-panel">
      <header className="inspector-header">
        <nav aria-label="Inspector">
          {(['changes', 'commands', 'browser', 'thread', 'runtime'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={tab === candidate ? 'active' : ''}
              onClick={() => setTab(candidate)}
            >
              {candidate}
              {candidate === 'changes' && workingFiles.length ? <span>{workingFiles.length}</span> : null}
              {candidate === 'commands' && commands.length ? <span>{commands.length}</span> : null}
              {candidate === 'browser' && browserSession?.recentActivities.length ? <span>{browserSession.recentActivities.length}</span> : null}
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
                            diffRequestSequence.current += 1;
                            setExpandedPath(null);
                            setLoadingDiff(false);
                            return;
                          }
                          const requestSequence = ++diffRequestSequence.current;
                          setExpandedPath(change.path);
                          setDiff('');
                          setDiffError('');
                          setLoadingDiff(true);
                          void onLoadDiff(change.path)
                            .then((nextDiff) => {
                              if (requestSequence === diffRequestSequence.current) {
                                setDiff(nextDiff);
                              }
                            })
                            .catch((error) => {
                              if (requestSequence === diffRequestSequence.current) {
                                setDiffError(String(error));
                              }
                            })
                            .finally(() => {
                              if (requestSequence === diffRequestSequence.current) {
                                setLoadingDiff(false);
                              }
                            });
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
                    {command.cwd ? <button type="button" onClick={() => onOpenTerminal(command.cwd!)}>Project Terminal</button> : null}
                  </footer>
                </article>
              ))}
            </div>
          )
        ) : null}

        {tab === 'browser' ? (
          !browserDiagnostics?.configuration.configured ? (
            <div className="inspector-empty browser-empty-state">
              <AppIcon name="browser" size={22} />
              <strong>Browser setup required</strong>
              <p>Connect Playwright MCP to let Codex inspect and test web applications.</p>
              <button type="button" onClick={onBrowserSetup}>Open Browser Setup</button>
            </div>
          ) : !browserSession || browserSession.state === 'stopped' ? (
            <div className="inspector-empty browser-empty-state">
              <AppIcon name="browser" size={22} />
              <strong>No browser session</strong>
              <p>Ask Codex to open the application in a browser, or start a headed session manually.</p>
              <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('open')}>Open Browser</button>
            </div>
          ) : browserSession.state === 'disconnected' ||
            browserSession.state === 'failed' ? (
            <div className="inspector-empty browser-empty-state">
              <AppIcon name="warning" size={22} />
              <strong>
                {browserSession.state === 'disconnected'
                  ? 'Browser disconnected'
                  : 'Browser session failed'}
              </strong>
              <p>
                {browserSession.failure ||
                  'The isolated browser is no longer connected to this Codex thread.'}
              </p>
              <button
                type="button"
                disabled={browserBusy}
                onClick={() => onBrowserAction('restart')}
              >
                Recover Browser Session
              </button>
              <button type="button" onClick={onBrowserDiagnostics}>
                Browser Diagnostics
              </button>
            </div>
          ) : (
            <div className="browser-inspector">
              <section className="browser-inspector-status">
                <span className={`browser-state-dot ${browserSession.state}`} />
                <div>
                  <strong>{browserSession.lastPageTitle || 'Browser session'}</strong>
                  <p>{browserSession.controlOwner === 'user' ? 'User controlling browser' : browserSession.state === 'codexActive' ? 'Codex controlling browser' : 'Ready for Codex'}</p>
                </div>
              </section>
              {browserSession.lastUrl ? (
                <button
                  type="button"
                  className="browser-current-url"
                  title={browserSession.lastUrl}
                  onClick={onOpenBrowserPage}
                >
                  {browserSession.lastUrl}
                </button>
              ) : null}
              {browserSession.lastScreenshotReference ? (
                <section className="browser-inspector-screenshot">
                  <header>
                    <strong>Latest screenshot</strong>
                    <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('takeScreenshot')}>Refresh</button>
                  </header>
                  {browserScreenshot ? (
                    <img src={browserScreenshot} alt={`Latest browser view for ${browserSession.lastPageTitle || thread.title}`} />
                  ) : browserScreenshotError ? (
                    <p>{browserScreenshotError}</p>
                  ) : (
                    <div className="browser-screenshot-loading">Loading screenshot…</div>
                  )}
                </section>
              ) : (
                <button type="button" className="browser-capture-empty" disabled={browserBusy} onClick={() => onBrowserAction('takeScreenshot')}>
                  <AppIcon name="camera" />
                  Capture the current page
                </button>
              )}
              <section className="browser-inspector-metrics">
                <div><strong>{browserSession.consoleErrorCount}</strong><span>Console errors</span></div>
                <div><strong>{browserSession.failedRequestCount}</strong><span>Failed requests</span></div>
              </section>
              <section className="browser-recent-actions">
                <h3>Recent activity</h3>
                {browserSession.recentActivities.slice(-8).reverse().map((activity) => (
                  <div key={`${activity.id}-${activity.timestamp}`}>
                    <span className={`browser-state-dot ${activity.status === 'failed' ? 'failed' : activity.status === 'inProgress' ? 'codexActive' : 'ready'}`} />
                    <span><strong>{activity.label}</strong><small>{activity.pageTitle || activity.url || activity.tool}</small></span>
                  </div>
                ))}
              </section>
              <section className="inspector-button-stack">
                {browserSession.controlOwner === 'user' ? (
                  <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('returnToCodex')}><AppIcon name="check" />Return to Codex</button>
                ) : (
                  <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('takeControl')}><AppIcon name="browser" />Take Control</button>
                )}
                <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('inspectConsole')}><AppIcon name="code" />Inspect console errors</button>
                <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('inspectNetwork')}><AppIcon name="info" />Inspect failed requests</button>
                <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('restart')}><AppIcon name="refresh" />Restart browser session</button>
                <button type="button" disabled={browserBusy} onClick={() => onBrowserAction('stop')}><AppIcon name="stop" />Stop browser session</button>
                <button type="button" onClick={onBrowserDiagnostics}><AppIcon name="info" />Browser diagnostics</button>
              </section>
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
                <div>
                  <dt>Speed</dt>
                  <dd>
                    {serviceTierDisplayName(
                      undefined,
                      session?.settings.effectiveServiceTier ??
                        metadata?.requestedServiceTier
                    ) || 'Runtime default'}
                  </dd>
                </div>
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
              <button type="button" onClick={() => onOpenTerminal(thread.cwd)}><AppIcon name="terminal" />Open Project Terminal</button>
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

function inspectorMetadataEqual(
  left: CodexThreadUiMetadata | undefined,
  right: CodexThreadUiMetadata | undefined
): boolean {
  return (
    left?.requestedModel === right?.requestedModel &&
    left?.requestedReasoningEffort === right?.requestedReasoningEffort &&
    left?.requestedServiceTier === right?.requestedServiceTier &&
    left?.permissionMode === right?.permissionMode
  );
}

export const InspectorPanel = memo(
  InspectorPanelComponent,
  (previous, next) =>
    previous.thread === next.thread &&
    previous.workspacePath === next.workspacePath &&
    previous.session === next.session &&
    inspectorMetadataEqual(previous.metadata, next.metadata) &&
    previous.diagnostics === next.diagnostics &&
    previous.browserSession === next.browserSession &&
    previous.browserDiagnostics === next.browserDiagnostics &&
    previous.browserBusy === next.browserBusy &&
    previous.gitInfo === next.gitInfo &&
    previous.gitStatus === next.gitStatus &&
    previous.gitBranches === next.gitBranches
);
