import type {
  CodexDiagnostics,
  CodexRuntimeCatalog
} from '../types';

export interface CodexRuntimeBootstrapSource {
  getCatalog: () => Promise<CodexRuntimeCatalog>;
  getDiagnostics: () => Promise<CodexDiagnostics>;
}

export interface CodexRuntimeBootstrapResult {
  catalog: CodexRuntimeCatalog;
  diagnostics: CodexDiagnostics;
}

/**
 * The catalog request waits for the Rust runtime to finish initialization.
 * Reading diagnostics afterwards prevents an earlier "initializing" snapshot
 * from overwriting the Ready state when the startup event arrived before the
 * WebView subscribed.
 */
export async function bootstrapCodexRuntime(
  source: CodexRuntimeBootstrapSource
): Promise<CodexRuntimeBootstrapResult> {
  const catalog = await source.getCatalog();
  const diagnostics = await source.getDiagnostics();
  return { catalog, diagnostics };
}

/**
 * Runtime events and Tauri command responses use separate delivery paths.
 * Retry the snapshot when an event arrived while it was in flight so an older
 * command response cannot overwrite a newer event.
 */
export async function readStableRuntimeDiagnostics(
  getDiagnostics: () => Promise<CodexDiagnostics>,
  getEventRevision: () => number,
  maxAttempts = 4
): Promise<CodexDiagnostics> {
  let latest: CodexDiagnostics | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const revision = getEventRevision();
    latest = await getDiagnostics();
    if (revision === getEventRevision()) return latest;
  }
  return latest ?? getDiagnostics();
}
