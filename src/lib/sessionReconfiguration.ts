import type {
  CodexThreadSession,
  ThreadPreferences
} from '../types';

export interface SessionReconfigurationClient {
  interruptCodexTurn: (threadId: string, turnId: string) => Promise<void>;
  resumeCodexThread: (
    workspacePath: string,
    threadId: string,
    preferences: ThreadPreferences
  ) => Promise<CodexThreadSession>;
}

export interface SessionReconfigurationRequest {
  workspacePath: string;
  threadId: string;
  activeTurnId?: string | null;
  preferences: ThreadPreferences;
}

export function requiresSessionReinstantiation(
  previous: ThreadPreferences,
  next: ThreadPreferences
): boolean {
  return (
    previous.permissionMode !== next.permissionMode ||
    previous.reasoningEffort !== next.reasoningEffort
  );
}

export async function reinstantiateCodexThreadSession(
  client: SessionReconfigurationClient,
  request: SessionReconfigurationRequest
): Promise<{ session: CodexThreadSession; interrupted: boolean }> {
  const activeTurnId = request.activeTurnId?.trim();
  if (activeTurnId) {
    await client.interruptCodexTurn(request.threadId, activeTurnId);
  }
  const session = await client.resumeCodexThread(
    request.workspacePath,
    request.threadId,
    request.preferences
  );
  return { session, interrupted: Boolean(activeTurnId) };
}
