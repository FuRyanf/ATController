import * as React from 'react';

import { api } from '../lib/api';
import type {
  CodexModelOption,
  CodexRateLimitWindow,
  CodexRuntimeOverview,
  CodexRuntimePreferences,
  Workspace
} from '../types';

interface CodexRuntimeControlProps {
  workspace?: Workspace;
}

const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function selectedModel(overview: CodexRuntimeOverview | null): CodexModelOption | null {
  if (!overview) {
    return null;
  }
  return (
    overview.models.find((model) => model.id === overview.selectedModel) ??
    overview.models.find((model) => model.isDefault) ??
    overview.models[0] ??
    null
  );
}

function shortUsage(window: CodexRateLimitWindow | null | undefined): string {
  return window ? `${Math.round(window.usedPercent)}%` : '—';
}

function resetLabel(window: CodexRateLimitWindow | null | undefined): string {
  if (!window?.resetsAt) {
    return 'Reset time unavailable';
  }
  return `Resets ${new Date(window.resetsAt * 1000).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })}`;
}

function UsageWindow({
  label,
  window
}: {
  label: string;
  window?: CodexRateLimitWindow | null;
}) {
  const usedPercent = window ? Math.min(100, Math.max(0, window.usedPercent)) : 0;
  return (
    <div className="codex-usage-window">
      <div className="codex-usage-window-header">
        <span>{label}</span>
        <span>{window ? `${Math.round(usedPercent)}% used` : 'Unavailable'}</span>
      </div>
      <div
        className={window ? 'codex-usage-progress' : 'codex-usage-progress unavailable'}
        role="progressbar"
        aria-label={`${label} Codex usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window ? Math.round(usedPercent) : undefined}
        aria-valuetext={window ? `${Math.round(usedPercent)} percent used` : 'Not reported by Codex'}
      >
        <span style={{ width: `${usedPercent}%` }} />
      </div>
      <span className="codex-usage-reset">
        {window ? resetLabel(window) : 'Not reported for this account'}
      </span>
    </div>
  );
}

export function CodexRuntimeControl({ workspace }: CodexRuntimeControlProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [overview, setOverview] = React.useState<CodexRuntimeOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (showLoading = false) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const next = await api.getCodexRuntimeOverview();
      setOverview(next);
      setError(null);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => void refresh(false), USAGE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  React.useEffect(() => {
    if (!open) {
      return () => undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  React.useEffect(() => {
    if (open) {
      void refresh(false);
    }
  }, [open, refresh]);

  const model = selectedModel(overview);
  const localControlsAvailable = !workspace || workspace.kind === 'local' || !workspace.kind;

  const updatePreferences = React.useCallback(
    async (preferences: CodexRuntimePreferences) => {
      if (saving) {
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const next = await api.updateCodexRuntimePreferences(preferences);
        setOverview(next);
      } catch (saveError) {
        setError(String(saveError));
        await refresh(false);
      } finally {
        setSaving(false);
      }
    },
    [refresh, saving]
  );

  const chooseModel = (modelId: string) => {
    if (!overview) {
      return;
    }
    const nextModel = overview.models.find((candidate) => candidate.id === modelId);
    if (!nextModel) {
      return;
    }
    const currentEffortIsSupported = nextModel.supportedReasoningEfforts.some(
      (effort) => effort.value === overview.selectedReasoningEffort
    );
    void updatePreferences({
      model: nextModel.id,
      reasoningEffort: currentEffortIsSupported
        ? overview.selectedReasoningEffort
        : nextModel.defaultReasoningEffort,
      fastMode: overview.fastMode && nextModel.supportsFastMode
    });
  };

  const chooseReasoningEffort = (reasoningEffort: string) => {
    if (!overview) {
      return;
    }
    void updatePreferences({
      model: overview.selectedModel,
      reasoningEffort,
      fastMode: overview.fastMode
    });
  };

  const chooseSpeed = (fastMode: boolean) => {
    if (!overview) {
      return;
    }
    void updatePreferences({
      model: overview.selectedModel,
      reasoningEffort: overview.selectedReasoningEffort,
      fastMode
    });
  };

  return (
    <div className="codex-runtime-control" ref={rootRef}>
      <button
        type="button"
        className="codex-runtime-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
        title="Codex model, speed, and usage"
      >
        <span className="codex-runtime-trigger-main">
          {loading && !overview ? 'Codex…' : model?.displayName ?? 'Codex'}
          {overview ? ` · ${overview.fastMode ? 'Fast' : 'Standard'}` : ''}
        </span>
        <span className="codex-runtime-trigger-usage">
          5h {shortUsage(overview?.fiveHourLimit)} · Week {shortUsage(overview?.weeklyLimit)}
        </span>
      </button>

      {open ? (
        <section className="codex-runtime-popover" role="dialog" aria-label="Codex runtime controls">
          <header className="codex-runtime-popover-header">
            <div>
              <strong>Codex</strong>
              <span>{overview?.planType ? `${overview.planType} plan` : 'Runtime settings'}</span>
            </div>
            <button
              type="button"
              className="codex-runtime-refresh"
              onClick={() => void refresh(true)}
              disabled={loading || saving}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </header>

          {!localControlsAvailable ? (
            <p className="codex-runtime-note">
              Model and speed controls apply to local Codex sessions. Usage is still shown below.
            </p>
          ) : null}

          <div className="codex-runtime-fields">
            <label>
              <span>Model</span>
              <select
                aria-label="Codex model"
                value={overview?.selectedModel ?? ''}
                onChange={(event) => chooseModel(event.target.value)}
                disabled={!overview || saving || !localControlsAvailable}
              >
                {overview?.models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.displayName}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Reasoning</span>
              <select
                aria-label="Codex reasoning effort"
                value={overview?.selectedReasoningEffort ?? ''}
                onChange={(event) => chooseReasoningEffort(event.target.value)}
                disabled={!model || saving || !localControlsAvailable}
              >
                {model?.supportedReasoningEfforts.map((effort) => (
                  <option key={effort.value} value={effort.value}>
                    {effort.value.charAt(0).toUpperCase() + effort.value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="codex-speed-control">
            <span>Speed</span>
            <div className="codex-speed-segments">
              <button
                type="button"
                className={!overview?.fastMode ? 'selected' : ''}
                aria-pressed={!overview?.fastMode}
                onClick={() => chooseSpeed(false)}
                disabled={!overview || saving || !localControlsAvailable}
              >
                Standard
              </button>
              <button
                type="button"
                className={overview?.fastMode ? 'selected' : ''}
                aria-pressed={overview?.fastMode ?? false}
                onClick={() => chooseSpeed(true)}
                disabled={
                  !overview ||
                  !model?.supportsFastMode ||
                  saving ||
                  !localControlsAvailable
                }
                title={model?.supportsFastMode ? 'Use Fast mode' : 'Fast mode is unavailable for this model'}
              >
                Fast
              </button>
            </div>
          </div>

          <div className="codex-usage-grid">
            <UsageWindow label="5-hour usage" window={overview?.fiveHourLimit} />
            <UsageWindow label="Weekly usage" window={overview?.weeklyLimit} />
          </div>

          {error ? <p className="codex-runtime-error">{error}</p> : null}
          <p className="codex-runtime-note">
            Model and speed changes apply when a Codex session starts or resumes.
          </p>
        </section>
      ) : null}
    </div>
  );
}
