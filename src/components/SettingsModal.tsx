import { useEffect, useState } from 'react';

import {
  TERMINAL_SCROLLBACK_LINES_MAX,
  TERMINAL_SCROLLBACK_LINES_MIN,
  normalizeTerminalScrollbackLines,
  type AppearanceMode
} from '../types';
import { SettingsActionFooter, SettingsRow, SettingsSection } from './SettingsLayout';

interface SettingsModalProps {
  open: boolean;
  initialCliPath: string;
  initialAppearanceMode: AppearanceMode;
  initialDefaultNewThreadFullAccess: boolean;
  initialTaskCompletionAlerts: boolean;
  initialTerminalScrollbackLines: number;
  detectedCliPath?: string | null;
  copyEnvDiagnosticsDisabled?: boolean;
  onClose: () => void;
  onSave: (settings: {
    cliPath: string;
    appearanceMode: AppearanceMode;
    defaultNewThreadFullAccess: boolean;
    taskCompletionAlerts: boolean;
    terminalScrollbackLines: number;
  }) => void;
  onCopyEnvDiagnostics?: () => void | Promise<void>;
  onSendTestAlert?: () => void | Promise<void>;
  testAlertDisabled?: boolean;
}

const APPEARANCE_OPTIONS: Array<{ value: AppearanceMode; label: string; description: string }> = [
  {
    value: 'system',
    label: 'System',
    description: 'Default. Follow the current macOS appearance automatically.'
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Brighter chrome while keeping terminal contrast readable.'
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Calm, low-glare shell surfaces built for long terminal sessions.'
  }
];

const SCROLLBACK_FIELD_STEP = 1_000;

function formatScrollbackLines(value: number): string {
  return value.toLocaleString('en-US');
}

export function SettingsModal({
  open,
  initialCliPath,
  initialAppearanceMode,
  initialDefaultNewThreadFullAccess,
  initialTaskCompletionAlerts,
  initialTerminalScrollbackLines,
  detectedCliPath,
  copyEnvDiagnosticsDisabled = false,
  onClose,
  onSave,
  onCopyEnvDiagnostics,
  onSendTestAlert,
  testAlertDisabled = false
}: SettingsModalProps) {
  const [cliPath, setCliPath] = useState(initialCliPath);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(initialAppearanceMode);
  const [defaultNewThreadFullAccess, setDefaultNewThreadFullAccess] = useState(initialDefaultNewThreadFullAccess);
  const [taskCompletionAlerts, setTaskCompletionAlerts] = useState(initialTaskCompletionAlerts);
  const [terminalScrollbackLinesInput, setTerminalScrollbackLinesInput] = useState(
    String(normalizeTerminalScrollbackLines(initialTerminalScrollbackLines))
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setCliPath(initialCliPath);
    setAppearanceMode(initialAppearanceMode);
    setDefaultNewThreadFullAccess(initialDefaultNewThreadFullAccess);
    setTaskCompletionAlerts(initialTaskCompletionAlerts);
    setTerminalScrollbackLinesInput(String(normalizeTerminalScrollbackLines(initialTerminalScrollbackLines)));
  }, [
    initialAppearanceMode,
    initialCliPath,
    initialDefaultNewThreadFullAccess,
    initialTaskCompletionAlerts,
    initialTerminalScrollbackLines,
    open
  ]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const terminalScrollbackLines = normalizeTerminalScrollbackLines(
    Number.parseInt(terminalScrollbackLinesInput, 10)
  );

  return (
    <div className="modal-backdrop">
      <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-modal-header">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p>Keep appearance, Claude, and alerts in one place.</p>
          </div>
        </header>

        <div className="settings-panel settings-panel-columns">
          <div className="settings-panel-column">
            <SettingsSection title="Appearance" description="Choose how ATController appears. System follows macOS by default.">
              <SettingsRow
                align="start"
                label="Mode"
                description="Switch instantly between the three available themes."
                controlClassName="settings-row-control-wrap"
                control={
                  <div className="appearance-toggle-group" role="radiogroup" aria-label="Appearance mode">
                    {APPEARANCE_OPTIONS.map((option) => {
                      const active = appearanceMode === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-description={option.description}
                          className={active ? 'appearance-toggle-option active' : 'appearance-toggle-option'}
                          onClick={() => setAppearanceMode(option.value)}
                        >
                          <span className="appearance-toggle-label">{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                }
              />
            </SettingsSection>

            <SettingsSection title="Alerts" description="Notifications for long-running Claude tasks.">
              <SettingsRow
                label={<span id="settings-task-completion-alerts-title">Task completion alerts</span>}
                description={
                  <span id="settings-task-completion-alerts-description">
                    Show a desktop notification and play a sound when Claude finishes a task.
                  </span>
                }
                control={
                  <button
                    type="button"
                    role="switch"
                    aria-labelledby="settings-task-completion-alerts-title"
                    aria-describedby="settings-task-completion-alerts-description"
                    aria-checked={taskCompletionAlerts}
                    className={taskCompletionAlerts ? 'settings-switch active' : 'settings-switch'}
                    onClick={() => setTaskCompletionAlerts((current) => !current)}
                  >
                    <span className="settings-switch-track">
                      <span className="settings-switch-thumb" />
                    </span>
                    <span className="settings-switch-label">{taskCompletionAlerts ? 'On' : 'Off'}</span>
                  </button>
                }
              />
            </SettingsSection>

            <SettingsSection
              title="Terminal"
              description="Choose how much terminal history stays available before older lines roll off."
            >
              <SettingsRow
                align="start"
                label={<label htmlFor="terminal-scrollback-lines">Scrollback lines</label>}
                description={`Higher values preserve more history but increase terminal memory use. ${formatScrollbackLines(TERMINAL_SCROLLBACK_LINES_MIN)} to ${formatScrollbackLines(TERMINAL_SCROLLBACK_LINES_MAX)} lines.`}
                controlClassName="settings-row-control-stack"
                control={
                  <>
                    <input
                      id="terminal-scrollback-lines"
                      type="number"
                      min={TERMINAL_SCROLLBACK_LINES_MIN}
                      max={TERMINAL_SCROLLBACK_LINES_MAX}
                      step={SCROLLBACK_FIELD_STEP}
                      inputMode="numeric"
                      value={terminalScrollbackLinesInput}
                      onChange={(event) => setTerminalScrollbackLinesInput(event.target.value)}
                      onBlur={() => setTerminalScrollbackLinesInput(String(terminalScrollbackLines))}
                    />
                    <p className="muted">
                      Active value: {formatScrollbackLines(terminalScrollbackLines)} lines
                    </p>
                  </>
                }
              />
            </SettingsSection>
          </div>

          <div className="settings-panel-column">
            <SettingsSection
              title="Claude"
              description="Set the Claude CLI path and the default access level used for new threads."
            >
              <SettingsRow
                align="start"
                label={<label htmlFor="cli-path">Claude path</label>}
                controlClassName="settings-row-control-stack"
                control={
                  <>
                    <input
                      id="cli-path"
                      type="text"
                      placeholder="/opt/homebrew/bin/claude"
                      value={cliPath}
                      onChange={(event) => setCliPath(event.target.value)}
                    />

                    {detectedCliPath ? (
                      <div className="settings-field-hint-row">
                        <p className="muted">Detected path: {detectedCliPath}</p>
                        {detectedCliPath !== cliPath.trim() ? (
                          <button
                            type="button"
                            className="ghost-button settings-inline-button"
                            onClick={() => setCliPath(detectedCliPath)}
                          >
                            Use detected path
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                }
              />

              <SettingsRow
                label={<span id="settings-default-full-access-title">Start new threads with Full access</span>}
                description={
                  <span id="settings-default-full-access-description">
                    When enabled, the main new-thread action creates a full-access thread by default.
                  </span>
                }
                control={
                  <button
                    type="button"
                    role="switch"
                    aria-labelledby="settings-default-full-access-title"
                    aria-describedby="settings-default-full-access-description"
                    aria-checked={defaultNewThreadFullAccess}
                    className={defaultNewThreadFullAccess ? 'settings-switch active' : 'settings-switch'}
                    onClick={() => setDefaultNewThreadFullAccess((current) => !current)}
                  >
                    <span className="settings-switch-track">
                      <span className="settings-switch-thumb" />
                    </span>
                    <span className="settings-switch-label">{defaultNewThreadFullAccess ? 'On' : 'Off'}</span>
                  </button>
                }
              />
            </SettingsSection>
          </div>
        </div>

        <SettingsActionFooter
          leading={
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void onCopyEnvDiagnostics?.()}
                disabled={copyEnvDiagnosticsDisabled}
              >
                Copy terminal env diagnostics
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void onSendTestAlert?.()}
                disabled={!initialTaskCompletionAlerts || !taskCompletionAlerts || testAlertDisabled}
              >
                Send test alert
              </button>
            </>
          }
          trailing={
            <>
              <button type="button" className="ghost-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  onSave({
                    cliPath: cliPath.trim(),
                    appearanceMode,
                    defaultNewThreadFullAccess,
                    taskCompletionAlerts,
                    terminalScrollbackLines
                  })
                }
              >
                Save
              </button>
            </>
          }
        />
      </section>
    </div>
  );
}
