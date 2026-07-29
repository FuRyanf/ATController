import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ControlCenterDialog } from '../../src/components/ControlCenterDialog';
import type {
  CodexDiagnostics,
  CodexRuntimeCatalog,
  Settings
} from '../../src/types';

const settings: Settings = {
  appearanceMode: 'system',
  defaultNewThreadFullAccess: true,
  defaultPermissionMode: 'fullAccess',
  defaultModel: 'runtime-model',
  defaultReasoningEffort: 'high',
  resumeTerminalBehavior: 'insertForReview',
  commandEnterToSend: true,
  taskCompletionAlerts: true
};

const catalog: CodexRuntimeCatalog = {
  models: [
    {
      id: 'runtime-model',
      model: 'runtime-model',
      displayName: 'Runtime Model',
      description: 'Supplied by Codex',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'high',
      reasoningEfforts: [
        { value: 'medium', description: '' },
        { value: 'high', description: '' },
        { value: 'ultra', description: '' }
      ],
      serviceTiers: [
        { id: 'standard', name: 'Standard', description: '' },
        { id: 'priority', name: 'Fast', description: '' }
      ],
      defaultServiceTier: 'standard',
      inputModalities: ['text', 'image']
    }
  ],
  account: {
    signedIn: true,
    authenticationMode: 'chatgpt',
    planType: 'pro',
    requiresOpenaiAuth: true,
    fiveHourLimit: { usedPercent: 20, windowDurationMins: 300 },
    weeklyLimit: { usedPercent: 55, windowDurationMins: 10_080 }
  },
  permissionProfiles: []
};

const diagnostics: CodexDiagnostics = {
  atcontrollerVersion: '0.0.22',
  codexBinaryPath: '/opt/codex',
  codexVersion: 'codex-cli 0.144.0',
  appServerSupported: true,
  generatedSchemaVersion: 'codex-cli 0.144.0',
  transport: 'stdio-jsonl',
  connectionState: 'ready',
  initialized: true,
  processId: 123,
  processUptimeMs: 62_000,
  codexHome: '/tmp/.codex',
  platformFamily: 'unix',
  platformOs: 'macos',
  authenticationState: 'chatgpt',
  planType: 'pro',
  currentModel: 'runtime-model',
  currentReasoningEffort: 'high',
  currentPermissionProfile: 'fullAccess',
  approvalPolicy: 'never',
  sandboxPolicy: 'dangerFullAccess',
  workspacePath: '/tmp/project',
  activeThreadId: 'thread-1',
  activeTurnId: null,
  pendingRequests: 0,
  eventQueueDepth: 0,
  recentStderr: ['redacted diagnostic'],
  recentProtocolErrors: [],
  restartAttempts: 0
};

function props() {
  return {
    open: true,
    initialTab: 'settings' as const,
    settings,
    catalog,
    diagnostics,
    dataRoot: '/tmp/ATController',
    selfTestResult: null,
    busy: false,
    onClose: vi.fn(),
    onSaveSettings: vi.fn(),
    onRestartRuntime: vi.fn(),
    onRunSelfTest: vi.fn(),
    onRegenerateProtocol: vi.fn(),
    onCopyDiagnostics: vi.fn(),
    onOpenDataRoot: vi.fn(),
    onOpenCodexConfiguration: vi.fn()
  };
}

describe('ATController control center', () => {
  it('edits appearance, permissions, and composer behavior as one settings update', async () => {
    const user = userEvent.setup();
    const control = props();
    render(<ControlCenterDialog {...control} />);

    await user.click(screen.getByRole('radio', { name: 'Light' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Permission mode' }),
      'standard'
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Service tier' }),
      'priority'
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'Also send with Command Enter' })
    );
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(control.onSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        appearanceMode: 'light',
        defaultPermissionMode: 'standard',
        defaultNewThreadFullAccess: false,
        commandEnterToSend: false,
        defaultServiceTier: 'priority'
      })
    );
  });

  it('shows runtime health and invokes every recovery action', async () => {
    const user = userEvent.setup();
    const control = { ...props(), initialTab: 'diagnostics' as const };
    render(<ControlCenterDialog {...control} />);

    expect(screen.getAllByText('codex-cli 0.144.0')).toHaveLength(2);
    expect(screen.getByText('dangerFullAccess')).toBeInTheDocument();
    expect(screen.getByText('/tmp/ATController')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /Run connection self test/ })
    );
    await user.click(
      screen.getByRole('button', { name: /Restart Codex runtime/ })
    );
    await user.click(
      screen.getByRole('button', { name: /Regenerate protocol bindings/ })
    );
    await user.click(screen.getByRole('button', { name: /Copy diagnostics/ }));
    await user.click(screen.getByRole('button', { name: /Open data directory/ }));
    await user.click(
      screen.getByRole('button', { name: /Open Codex configuration/ })
    );

    expect(control.onRunSelfTest).toHaveBeenCalledOnce();
    expect(control.onRestartRuntime).toHaveBeenCalledOnce();
    expect(control.onRegenerateProtocol).toHaveBeenCalledOnce();
    expect(control.onCopyDiagnostics).toHaveBeenCalledOnce();
    expect(control.onOpenDataRoot).toHaveBeenCalledOnce();
    expect(control.onOpenCodexConfiguration).toHaveBeenCalledOnce();
  });
});
