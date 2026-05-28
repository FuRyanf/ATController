import { normalizeAgentProvider, type AgentProvider } from '../types';

const TEST_AGENT_PROVIDER_OVERRIDE_KEY = 'atcontroller:test-agent-provider';

export function getConfiguredAgentProvider(): AgentProvider {
  if (import.meta.env.MODE === 'test' && typeof window !== 'undefined') {
    try {
      const override = window.localStorage.getItem(TEST_AGENT_PROVIDER_OVERRIDE_KEY);
      if (override) {
        return normalizeAgentProvider(override);
      }
    } catch {
      // Fall through to the build-time provider.
    }
  }

  return normalizeAgentProvider(import.meta.env.VITE_ATCONTROLLER_AGENT_PROVIDER);
}

