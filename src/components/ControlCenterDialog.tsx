import { useEffect, useState } from 'react';

import type {
  AppearanceMode,
  BrowserDiagnostics,
  BrowserSelfTestResult,
  BrowserSetupPlan,
  CodexDiagnostics,
  CodexRuntimeCatalog,
  PermissionMode,
  Settings
} from '../types';
import {
  isNormalServiceTierId,
  NORMAL_SERVICE_TIER_ID,
  serviceTierDisplayName
} from '../lib/codexLabels';
import {
  formatUsageRemaining,
  formatUsageReset,
  usageRemainingPercent
} from '../lib/usage';
import { AppIcon } from './AppIcon';

type ControlCenterTab = 'settings' | 'diagnostics' | 'browser';

interface ControlCenterDialogProps {
  open: boolean;
  initialTab: ControlCenterTab;
  settings: Settings;
  catalog: CodexRuntimeCatalog | null;
  diagnostics: CodexDiagnostics | null;
  browserDiagnostics: BrowserDiagnostics | null;
  browserSetupPlan: BrowserSetupPlan | null;
  browserSelfTestResult: BrowserSelfTestResult | Record<string, unknown> | null;
  dataRoot: string;
  selfTestResult: Record<string, unknown> | null;
  busy: boolean;
  onClose: () => void;
  onSaveSettings: (settings: Settings) => void;
  onRestartRuntime: () => void;
  onRunSelfTest: () => void;
  onRegenerateProtocol: () => void;
  onCopyDiagnostics: () => void;
  onOpenDataRoot: () => void;
  onOpenCodexConfiguration: () => void;
  onConfigureBrowser: () => void;
  onRunBrowserSelfTest: () => void;
  onCopyBrowserDiagnostics: () => void;
  onOpenBrowserCache: () => void;
}

function permissionLabel(permission: PermissionMode): string {
  if (permission === 'workspaceAccess') return 'Workspace Access';
  if (permission === 'fullAccess') return 'Full Access';
  return 'Standard';
}

function formatDuration(milliseconds?: number | null): string {
  if (milliseconds == null) return 'Not running';
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function ControlCenterDialog({
  open,
  initialTab,
  settings,
  catalog,
  diagnostics,
  browserDiagnostics,
  browserSetupPlan,
  browserSelfTestResult,
  dataRoot,
  selfTestResult,
  busy,
  onClose,
  onSaveSettings,
  onRestartRuntime,
  onRunSelfTest,
  onRegenerateProtocol,
  onCopyDiagnostics,
  onOpenDataRoot,
  onOpenCodexConfiguration,
  onConfigureBrowser,
  onRunBrowserSelfTest,
  onCopyBrowserDiagnostics,
  onOpenBrowserCache
}: ControlCenterDialogProps) {
  const [tab, setTab] = useState<ControlCenterTab>(initialTab);
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setDraft(settings);
  }, [initialTab, open, settings]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, open]);

  if (!open) return null;

  const defaultPermission = draft.defaultPermissionMode ?? 'fullAccess';
  const defaultModel =
    catalog?.models.find((model) => model.id === draft.defaultModel || model.model === draft.defaultModel) ??
    catalog?.models.find((model) => model.isDefault) ??
    catalog?.models[0];
  const advertisedNormalTier = defaultModel?.serviceTiers.find((tier) =>
    isNormalServiceTierId(tier.id)
  );
  const requestedDefaultTierId =
    draft.defaultServiceTier ??
    catalog?.configuredServiceTier ??
    defaultModel?.defaultServiceTier ??
    advertisedNormalTier?.id ??
    NORMAL_SERVICE_TIER_ID;
  const selectedDefaultTierId = isNormalServiceTierId(requestedDefaultTierId)
    ? advertisedNormalTier?.id ?? NORMAL_SERVICE_TIER_ID
    : requestedDefaultTierId;

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <section
        className="control-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="control-center-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="control-center-title">ATController</h2>
            <p>Local Codex session settings and runtime health.</p>
          </div>
          <button type="button" className="icon-button subtle" aria-label="Close" onClick={onClose}><AppIcon name="close" /></button>
        </header>
        <nav>
          <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
          <button type="button" className={tab === 'diagnostics' ? 'active' : ''} onClick={() => setTab('diagnostics')}>
            Diagnostics
            <span className={`runtime-dot ${diagnostics?.connectionState ?? 'stopped'}`} />
          </button>
          <button type="button" className={tab === 'browser' ? 'active' : ''} onClick={() => setTab('browser')}>
            Browser
            <span
              className={`runtime-dot ${
                browserDiagnostics?.configuration.configured &&
                browserDiagnostics.codexCanSeeBrowserTools
                  ? 'ready'
                  : 'stopped'
              }`}
            />
          </button>
        </nav>

        <div className="control-center-content">
          {tab === 'settings' ? (
            <div className="settings-grid">
              <section className="usage-settings">
                <header>
                  <div>
                    <h3>Codex usage</h3>
                    <p>Current allowance reported by your Codex account.</p>
                  </div>
                  <span className="usage-plan">
                    {catalog?.account.planType ?? 'Plan unavailable'}
                  </span>
                </header>
                <div className="usage-windows">
                  {[
                    {
                      label: '5-hour limit',
                      window: catalog?.account.fiveHourLimit
                    },
                    {
                      label: 'Weekly limit',
                      window: catalog?.account.weeklyLimit
                    }
                  ].map(({ label, window }) => {
                    const remaining = usageRemainingPercent(window);
                    return (
                      <div className="usage-window" key={label}>
                        <div className="usage-window-heading">
                          <span>{label}</span>
                          <strong>{formatUsageRemaining(window)}</strong>
                        </div>
                        <div
                          className={`usage-meter ${remaining != null && remaining <= 20 ? 'low' : ''}`}
                          role="progressbar"
                          aria-label={`${label} remaining`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={remaining ?? undefined}
                        >
                          <span style={{ width: `${remaining ?? 0}%` }} />
                        </div>
                        <small>{formatUsageReset(window)}</small>
                      </div>
                    );
                  })}
                </div>
              </section>
              <section>
                <h3>Appearance</h3>
                <p>Follow macOS or choose an explicit theme.</p>
                <div className="segmented-control" role="radiogroup" aria-label="Appearance">
                  {(['system', 'light', 'dark'] as AppearanceMode[]).map((appearance) => (
                    <button
                      key={appearance}
                      type="button"
                      role="radio"
                      aria-checked={(draft.appearanceMode ?? 'system') === appearance}
                      className={(draft.appearanceMode ?? 'system') === appearance ? 'active' : ''}
                      onClick={() => setDraft({ ...draft, appearanceMode: appearance })}
                    >
                      {appearance[0].toUpperCase() + appearance.slice(1)}
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <h3>New threads</h3>
                <p>Defaults are applied through structured app-server fields.</p>
                <label>
                  <span>Permission mode</span>
                  <select
                    value={defaultPermission}
                    onChange={(event) => {
                      const permission = event.target.value as PermissionMode;
                      setDraft({
                        ...draft,
                        defaultPermissionMode: permission,
                        defaultNewThreadFullAccess: permission === 'fullAccess'
                      });
                    }}
                  >
                    {(['standard', 'workspaceAccess', 'fullAccess'] as PermissionMode[]).map((permission) => (
                      <option key={permission} value={permission}>{permissionLabel(permission)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Model</span>
                  <select
                    value={draft.defaultModel ?? defaultModel?.id ?? ''}
                    onChange={(event) => {
                      const model = catalog?.models.find((candidate) => candidate.id === event.target.value);
                      setDraft({
                        ...draft,
                        defaultModel: event.target.value || null,
                        defaultReasoningEffort: model?.defaultReasoningEffort ?? null,
                        defaultServiceTier: model?.defaultServiceTier ?? null
                      });
                    }}
                  >
                    {catalog?.models.map((model) => (
                      <option key={model.id} value={model.id}>{model.displayName || model.model}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Reasoning effort</span>
                  <select
                    value={draft.defaultReasoningEffort ?? defaultModel?.defaultReasoningEffort ?? ''}
                    onChange={(event) => setDraft({ ...draft, defaultReasoningEffort: event.target.value || null })}
                  >
                    {defaultModel?.reasoningEfforts.map((effort) => (
                      <option key={effort.value} value={effort.value}>{effort.value}</option>
                    ))}
                  </select>
                </label>
                {defaultModel?.serviceTiers.length ? (
                  <label>
                    <span>Speed</span>
                    <select
                      aria-label="Speed"
                      value={selectedDefaultTierId}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          defaultServiceTier: event.target.value || null
                        })
                      }
                    >
                      {!advertisedNormalTier ? (
                        <option value={NORMAL_SERVICE_TIER_ID}>
                          {serviceTierDisplayName(undefined, NORMAL_SERVICE_TIER_ID)}
                        </option>
                      ) : null}
                      {defaultModel.serviceTiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {serviceTierDisplayName(tier)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </section>
              <section>
                <h3>Terminal handoff</h3>
                <p>Choose what happens when a resume command is opened in Terminal.</p>
                <label>
                  <span>Open resume command</span>
                  <select
                    value={draft.resumeTerminalBehavior ?? 'insertForReview'}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        resumeTerminalBehavior: event.target.value as Settings['resumeTerminalBehavior']
                      })
                    }
                  >
                    <option value="insertForReview">Insert for review</option>
                    <option value="executeImmediately">Execute immediately</option>
                  </select>
                </label>
              </section>
              <section>
                <h3>Composer</h3>
                <p>Enter always sends. Shift Enter inserts a new line.</p>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.commandEnterToSend !== false}
                    onChange={(event) =>
                      setDraft({ ...draft, commandEnterToSend: event.target.checked })
                    }
                  />
                  <span>Also send with Command Enter</span>
                </label>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.taskCompletionAlerts !== false}
                    onChange={(event) =>
                      setDraft({ ...draft, taskCompletionAlerts: event.target.checked })
                    }
                  />
                  <span>Notify when background turns finish</span>
                </label>
              </section>
              <section>
                <h3>Codex executable</h3>
                <p>Leave blank to use login-shell and PATH discovery.</p>
                <label>
                  <span>Binary path</span>
                  <input
                    value={draft.codexCliPath ?? ''}
                    placeholder={diagnostics?.codexBinaryPath ?? '/path/to/codex'}
                    onChange={(event) => setDraft({ ...draft, codexCliPath: event.target.value || null })}
                  />
                </label>
              </section>
            </div>
          ) : tab === 'diagnostics' ? (
            <div className="diagnostics-view">
              <section className="diagnostics-hero">
                <span className={`runtime-dot large ${diagnostics?.connectionState ?? 'stopped'}`} />
                <div>
                  <h3>{diagnostics?.connectionState ?? 'Runtime unavailable'}</h3>
                  <p>{diagnostics?.initialized ? 'Connected to Codex over structured JSONL stdio.' : 'The app-server handshake is not ready.'}</p>
                </div>
              </section>
              <section className="diagnostics-table">
                <dl>
                  <div><dt>ATController</dt><dd>{diagnostics?.atcontrollerVersion ?? 'Unknown'}</dd></div>
                  <div><dt>Codex</dt><dd>{diagnostics?.codexVersion ?? 'Not detected'}</dd></div>
                  <div><dt>Binary</dt><dd>{diagnostics?.codexBinaryPath ?? 'Not detected'}</dd></div>
                  <div><dt>App server</dt><dd>{diagnostics?.appServerSupported ? 'Supported' : 'Unsupported'}</dd></div>
                  <div><dt>Generated schema</dt><dd>{diagnostics?.generatedSchemaVersion ?? 'Unknown'}</dd></div>
                  <div><dt>Transport</dt><dd>{diagnostics?.transport ?? 'stdio-jsonl'}</dd></div>
                  <div><dt>Process</dt><dd>{diagnostics?.processId ?? 'Not running'}</dd></div>
                  <div><dt>Uptime</dt><dd>{formatDuration(diagnostics?.processUptimeMs)}</dd></div>
                  <div><dt>Codex home</dt><dd>{diagnostics?.codexHome ?? 'Default'}</dd></div>
                  <div><dt>Platform</dt><dd>{[diagnostics?.platformFamily, diagnostics?.platformOs].filter(Boolean).join(' · ') || 'Unknown'}</dd></div>
                  <div><dt>Authentication</dt><dd>{diagnostics?.authenticationState ?? 'Unknown'}</dd></div>
                  <div><dt>Plan</dt><dd>{diagnostics?.planType ?? 'Not supplied'}</dd></div>
                  <div><dt>Model</dt><dd>{diagnostics?.currentModel ?? 'Runtime default'}</dd></div>
                  <div><dt>Reasoning</dt><dd>{diagnostics?.currentReasoningEffort ?? 'Runtime default'}</dd></div>
                  <div><dt>Permission profile</dt><dd>{diagnostics?.currentPermissionProfile ?? 'Not active'}</dd></div>
                  <div><dt>Approval policy</dt><dd>{diagnostics?.approvalPolicy ?? 'Not active'}</dd></div>
                  <div><dt>Sandbox policy</dt><dd>{diagnostics?.sandboxPolicy ?? 'Not active'}</dd></div>
                  <div><dt>Workspace</dt><dd>{diagnostics?.workspacePath ?? 'None'}</dd></div>
                  <div><dt>Active thread</dt><dd>{diagnostics?.activeThreadId ?? 'None'}</dd></div>
                  <div><dt>Active turn</dt><dd>{diagnostics?.activeTurnId ?? 'None'}</dd></div>
                  <div><dt>Pending requests</dt><dd>{diagnostics?.pendingRequests ?? 0}</dd></div>
                  <div><dt>Event queue</dt><dd>{diagnostics?.eventQueueDepth ?? 0}</dd></div>
                  <div><dt>Restart attempts</dt><dd>{diagnostics?.restartAttempts ?? 0}</dd></div>
                  <div><dt>Last exit</dt><dd>{diagnostics?.lastProcessExit?.summary ?? 'None'}</dd></div>
                  <div><dt>Application data</dt><dd>{dataRoot}</dd></div>
                </dl>
              </section>
              {diagnostics?.recentProtocolErrors.length ? (
                <details className="diagnostic-logs">
                  <summary>Recent protocol errors ({diagnostics.recentProtocolErrors.length})</summary>
                  <pre>{diagnostics.recentProtocolErrors.join('\n')}</pre>
                </details>
              ) : null}
              {diagnostics?.recentStderr.length ? (
                <details className="diagnostic-logs">
                  <summary>Recent redacted stderr</summary>
                  <pre>{diagnostics.recentStderr.join('\n')}</pre>
                </details>
              ) : null}
              {selfTestResult ? <pre className="self-test-result">{JSON.stringify(selfTestResult, null, 2)}</pre> : null}
              <div className="diagnostic-actions">
                <button type="button" onClick={onRunSelfTest} disabled={busy}><AppIcon name="check" />Run connection self test</button>
                <button type="button" onClick={onRestartRuntime} disabled={busy}><AppIcon name="refresh" />Restart Codex runtime</button>
                <button type="button" onClick={onRegenerateProtocol} disabled={busy}><AppIcon name="refresh" />Regenerate protocol bindings</button>
                <button type="button" onClick={onCopyDiagnostics}><AppIcon name="copy" />Copy diagnostics</button>
                <button type="button" onClick={onOpenDataRoot}><AppIcon name="folder" />Open data directory</button>
                <button type="button" onClick={onOpenCodexConfiguration}><AppIcon name="folder" />Open Codex configuration</button>
              </div>
            </div>
          ) : (
            <div className="diagnostics-view browser-control-center">
              <section className="diagnostics-hero">
                <span
                  className={`runtime-dot large ${
                    browserDiagnostics?.configuration.configured &&
                    browserDiagnostics.codexCanSeeBrowserTools
                      ? 'ready'
                      : 'stopped'
                  }`}
                />
                <div>
                  <h3>
                    {browserDiagnostics?.codexCanSeeBrowserTools
                      ? 'Playwright browser tools ready'
                      : browserDiagnostics?.configuration.configured
                        ? 'Playwright MCP configured'
                        : 'Browser setup required'}
                  </h3>
                  <p>
                    Codex uses an isolated, headed browser through structured
                    Playwright MCP tool calls.
                  </p>
                </div>
              </section>

              <section className="diagnostics-table browser-diagnostics-table">
                <dl>
                  <div>
                    <dt>Node.js</dt>
                    <dd>
                      {browserDiagnostics?.node.available
                        ? `${browserDiagnostics.node.version ?? 'Detected'} · ${browserDiagnostics.node.path ?? ''}`
                        : browserDiagnostics?.node.detail ?? 'Not detected'}
                    </dd>
                  </div>
                  <div>
                    <dt>npx</dt>
                    <dd>
                      {browserDiagnostics?.npx.available
                        ? `${browserDiagnostics.npx.version ?? 'Detected'} · ${browserDiagnostics.npx.path ?? ''}`
                        : browserDiagnostics?.npx.detail ?? 'Not detected'}
                    </dd>
                  </div>
                  <div>
                    <dt>Browser</dt>
                    <dd>
                      {browserDiagnostics?.browser.available
                        ? `${browserDiagnostics.browser.version ?? 'Detected'} · ${browserDiagnostics.browser.path ?? ''}`
                        : browserDiagnostics?.browser.detail ?? 'Not detected'}
                    </dd>
                  </div>
                  <div><dt>Playwright browsers</dt><dd>{browserDiagnostics?.playwrightBrowsersAvailable ? 'Available' : 'Not detected'}</dd></div>
                  <div><dt>MCP server</dt><dd>{browserDiagnostics?.configuration.serverName ?? 'atcontroller-playwright'}</dd></div>
                  <div><dt>Package</dt><dd>{browserDiagnostics ? `${browserDiagnostics.configuration.package}@${browserDiagnostics.configuration.packageVersion}` : 'Not inspected'}</dd></div>
                  <div><dt>Configuration</dt><dd>{browserDiagnostics?.configuration.configured ? browserDiagnostics.configuration.managedByAtcontroller ? 'Configured by ATController' : 'Existing configuration' : 'Not configured'}</dd></div>
                  <div><dt>Codex visibility</dt><dd>{browserDiagnostics?.codexCanSeeServer ? browserDiagnostics.codexCanSeeBrowserTools ? `${browserDiagnostics.toolNames.length} browser tools` : 'Server visible; tools unavailable' : 'Server not visible'}</dd></div>
                  <div><dt>Profile</dt><dd>{browserDiagnostics?.configuration.isolated ? 'Isolated per MCP client' : 'Not isolated'}</dd></div>
                  <div><dt>Window</dt><dd>{browserDiagnostics?.configuration.headed ? 'Headed browser' : 'Headless browser'}</dd></div>
                  <div><dt>Screenshot cache</dt><dd>{browserDiagnostics?.screenshotCachePath ?? 'Not available'}</dd></div>
                  <div><dt>Connection</dt><dd>{browserDiagnostics?.connectionState ?? 'Unknown'}</dd></div>
                </dl>
              </section>

              {!browserDiagnostics?.configuration.configured && browserSetupPlan ? (
                <section className="browser-setup-plan">
                  <h3>Configure Playwright MCP</h3>
                  <p>
                    ATController will add one named MCP entry to the Codex
                    configuration. npx downloads the pinned package the first
                    time it starts. Your personal Chrome profile is never used.
                  </p>
                  {browserSetupPlan.command ? (
                    <pre>{browserSetupPlan.command}</pre>
                  ) : null}
                  <ul>
                    {browserSetupPlan.effects.map((effect) => <li key={effect}>{effect}</li>)}
                  </ul>
                  {browserSetupPlan.blockers.length ? (
                    <div className="browser-setup-blockers">
                      {browserSetupPlan.blockers.map((blocker) => (
                        <p key={blocker}><AppIcon name="warning" />{blocker}</p>
                      ))}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !browserSetupPlan.canConfigure}
                    onClick={onConfigureBrowser}
                  >
                    <AppIcon name="browser" />
                    Configure Playwright MCP
                  </button>
                </section>
              ) : null}

              {browserDiagnostics?.lastError ? (
                <p className="timeline-error">{browserDiagnostics.lastError}</p>
              ) : null}
              {browserSelfTestResult ? (
                <pre className="self-test-result">
                  {JSON.stringify(browserSelfTestResult, null, 2)}
                </pre>
              ) : null}
              <div className="diagnostic-actions">
                <button
                  type="button"
                  disabled={busy || !browserDiagnostics?.configuration.configured}
                  onClick={onRunBrowserSelfTest}
                >
                  <AppIcon name="check" />
                  Run Browser Self Test
                </button>
                <button type="button" onClick={onCopyBrowserDiagnostics}>
                  <AppIcon name="copy" />
                  Copy Browser Diagnostics
                </button>
                <button type="button" onClick={onOpenBrowserCache}>
                  <AppIcon name="folder" />
                  Open Screenshot Cache
                </button>
                <button type="button" onClick={onOpenCodexConfiguration}>
                  <AppIcon name="folder" />
                  Open Codex Configuration
                </button>
              </div>
            </div>
          )}
        </div>

        <footer>
          {tab === 'settings' ? (
            <>
              <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary-button" onClick={() => onSaveSettings(draft)}>Save settings</button>
            </>
          ) : (
            <button type="button" className="primary-button" onClick={onClose}>Done</button>
          )}
        </footer>
      </section>
    </div>
  );
}
