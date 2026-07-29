import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapCodexRuntime,
  readStableRuntimeDiagnostics
} from '../../src/lib/runtimeBootstrap';
import type {
  CodexDiagnostics,
  CodexRuntimeCatalog
} from '../../src/types';

function diagnostics(
  connectionState: CodexDiagnostics['connectionState']
): CodexDiagnostics {
  return {
    atcontrollerVersion: '0.0.22',
    codexBinaryPath: '/opt/codex',
    codexVersion: 'codex-cli 0.144.0',
    appServerSupported: true,
    generatedSchemaVersion: 'codex-cli 0.144.0',
    transport: 'stdio-jsonl',
    connectionState,
    initialized: connectionState === 'ready',
    processId: connectionState === 'ready' ? 42 : null,
    processUptimeMs: 1,
    codexHome: null,
    platformFamily: 'unix',
    platformOs: 'macos',
    authenticationState: null,
    planType: null,
    currentModel: null,
    currentReasoningEffort: null,
    currentPermissionProfile: null,
    approvalPolicy: null,
    sandboxPolicy: null,
    workspacePath: null,
    activeThreadId: null,
    activeTurnId: null,
    pendingRequests: 0,
    eventQueueDepth: 0,
    recentStderr: [],
    recentProtocolErrors: [],
    restartAttempts: 0
  };
}

const catalog: CodexRuntimeCatalog = {
  models: [],
  account: {
    signedIn: true,
    requiresOpenaiAuth: true
  },
  permissionProfiles: []
};

describe('Codex cold-start reconciliation', () => {
  it('reads diagnostics only after the catalog request has completed initialization', async () => {
    let state: CodexDiagnostics['connectionState'] = 'initializing';
    const order: string[] = [];
    const result = await bootstrapCodexRuntime({
      getCatalog: async () => {
        order.push('catalog');
        state = 'ready';
        return catalog;
      },
      getDiagnostics: async () => {
        order.push('diagnostics');
        return diagnostics(state);
      }
    });

    expect(order).toEqual(['catalog', 'diagnostics']);
    expect(result.diagnostics.connectionState).toBe('ready');
    expect(result.diagnostics.initialized).toBe(true);
  });

  it('retries a snapshot when a runtime event arrives while the command is in flight', async () => {
    let revision = 0;
    const getDiagnostics = vi
      .fn<() => Promise<CodexDiagnostics>>()
      .mockImplementationOnce(async () => {
        revision += 1;
        return diagnostics('initializing');
      })
      .mockResolvedValue(diagnostics('ready'));

    const result = await readStableRuntimeDiagnostics(
      getDiagnostics,
      () => revision
    );

    expect(getDiagnostics).toHaveBeenCalledTimes(2);
    expect(result.connectionState).toBe('ready');
  });
});
