import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexRuntimeOverview, CodexRuntimePreferences } from '../../src/types';

const mocks = vi.hoisted(() => ({
  getCodexRuntimeOverview: vi.fn(),
  updateCodexRuntimePreferences: vi.fn()
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    getCodexRuntimeOverview: mocks.getCodexRuntimeOverview,
    updateCodexRuntimePreferences: mocks.updateCodexRuntimePreferences
  }
}));

import { CodexRuntimeControl } from '../../src/components/CodexRuntimeControl';

function buildOverview(
  overrides: Partial<CodexRuntimeOverview> = {}
): CodexRuntimeOverview {
  return {
    selectedModel: 'gpt-5.2-codex',
    selectedReasoningEffort: 'high',
    fastMode: false,
    planType: 'Plus',
    models: [
      {
        id: 'gpt-5.2-codex',
        model: 'gpt-5.2-codex',
        displayName: 'GPT-5.2-Codex',
        description: 'Current Codex model',
        isDefault: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [
          { value: 'medium', description: 'Balanced reasoning' },
          { value: 'high', description: 'Deeper reasoning' }
        ],
        supportsFastMode: true
      },
      {
        id: 'gpt-5.3-codex',
        model: 'gpt-5.3-codex',
        displayName: 'GPT-5.3-Codex',
        description: 'Newest Codex model',
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { value: 'low', description: 'Quicker reasoning' },
          { value: 'medium', description: 'Balanced reasoning' }
        ],
        supportsFastMode: true
      }
    ],
    fiveHourLimit: {
      usedPercent: 42.6,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000
    },
    weeklyLimit: {
      usedPercent: 71.2,
      windowDurationMins: 10_080,
      resetsAt: 1_800_500_000
    },
    ...overrides
  };
}

function usageWindowFor(label: string): HTMLElement {
  const progress = screen.getByRole('progressbar', {
    name: `${label} Codex usage`
  });
  const window = progress.closest('.codex-usage-window');
  expect(window).not.toBeNull();
  return window as HTMLElement;
}

describe('CodexRuntimeControl', () => {
  let overview: CodexRuntimeOverview;

  beforeEach(() => {
    vi.clearAllMocks();
    overview = buildOverview();
    mocks.getCodexRuntimeOverview.mockImplementation(async () => overview);
    mocks.updateCodexRuntimePreferences.mockImplementation(
      async (preferences: CodexRuntimePreferences) => {
        overview = {
          ...overview,
          selectedModel: preferences.model,
          selectedReasoningEffort: preferences.reasoningEffort,
          fastMode: preferences.fastMode
        };
        return overview;
      }
    );
  });

  it('persists model, reasoning, and Fast preferences through the Codex API', async () => {
    const user = userEvent.setup();
    render(<CodexRuntimeControl />);

    await screen.findByText('5h 43% · Week 71%');
    await user.click(screen.getByTitle('Codex model, speed, and usage'));

    const modelSelect = screen.getByRole('combobox', { name: 'Codex model' });
    await user.selectOptions(modelSelect, 'gpt-5.3-codex');
    await waitFor(() => {
      expect(mocks.updateCodexRuntimePreferences).toHaveBeenLastCalledWith({
        model: 'gpt-5.3-codex',
        reasoningEffort: 'medium',
        fastMode: false
      });
      expect(modelSelect).not.toBeDisabled();
    });

    const reasoningSelect = screen.getByRole('combobox', {
      name: 'Codex reasoning effort'
    });
    await user.selectOptions(reasoningSelect, 'low');
    await waitFor(() => {
      expect(mocks.updateCodexRuntimePreferences).toHaveBeenLastCalledWith({
        model: 'gpt-5.3-codex',
        reasoningEffort: 'low',
        fastMode: false
      });
      expect(reasoningSelect).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: 'Fast' }));
    await waitFor(() => {
      expect(mocks.updateCodexRuntimePreferences).toHaveBeenLastCalledWith({
        model: 'gpt-5.3-codex',
        reasoningEffort: 'low',
        fastMode: true
      });
    });

    expect(mocks.updateCodexRuntimePreferences).toHaveBeenCalledTimes(3);
    expect(screen.getByTitle('Codex model, speed, and usage')).toHaveTextContent(
      'GPT-5.3-Codex · Fast'
    );
  });

  it('shows the reported 5-hour and weekly usage windows', async () => {
    const user = userEvent.setup();
    render(<CodexRuntimeControl />);

    await screen.findByText('5h 43% · Week 71%');
    await user.click(screen.getByTitle('Codex model, speed, and usage'));

    const fiveHourWindow = usageWindowFor('5-hour usage');
    expect(within(fiveHourWindow).getByText('43% used')).toBeInTheDocument();
    expect(
      within(fiveHourWindow).getByRole('progressbar', {
        name: '5-hour usage Codex usage'
      })
    ).toHaveAttribute('aria-valuenow', '43');
    expect(within(fiveHourWindow).getByText(/^Resets /)).toBeInTheDocument();

    const weeklyWindow = usageWindowFor('Weekly usage');
    expect(within(weeklyWindow).getByText('71% used')).toBeInTheDocument();
    expect(
      within(weeklyWindow).getByRole('progressbar', {
        name: 'Weekly usage Codex usage'
      })
    ).toHaveAttribute('aria-valuenow', '71');
    expect(within(weeklyWindow).getByText(/^Resets /)).toBeInTheDocument();
  });

  it('marks an unavailable 5-hour window without hiding reported weekly usage', async () => {
    const user = userEvent.setup();
    overview = buildOverview({ fiveHourLimit: null });
    render(<CodexRuntimeControl />);

    await screen.findByText('5h — · Week 71%');
    await user.click(screen.getByTitle('Codex model, speed, and usage'));

    const fiveHourWindow = usageWindowFor('5-hour usage');
    expect(within(fiveHourWindow).getByText('Unavailable')).toBeInTheDocument();
    expect(within(fiveHourWindow).getByText('Not reported for this account')).toBeInTheDocument();
    const fiveHourProgress = within(fiveHourWindow).getByRole('progressbar', {
      name: '5-hour usage Codex usage'
    });
    expect(fiveHourProgress).not.toHaveAttribute('aria-valuenow');
    expect(fiveHourProgress).toHaveAttribute('aria-valuetext', 'Not reported by Codex');

    const weeklyWindow = usageWindowFor('Weekly usage');
    expect(within(weeklyWindow).getByText('71% used')).toBeInTheDocument();
    expect(
      within(weeklyWindow).getByRole('progressbar', {
        name: 'Weekly usage Codex usage'
      })
    ).toHaveAttribute('aria-valuenow', '71');
  });
});
