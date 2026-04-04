import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SettingsModal } from '../../src/components/SettingsModal';

describe('SettingsModal', () => {
  it('preserves the settings payload and footer action wiring in the compact layout', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCopyEnvDiagnostics = vi.fn();
    const onSave = vi.fn();
    const onSendTestAlert = vi.fn();

    render(
      <SettingsModal
        open
        initialCliPath="/usr/local/bin/claude"
        initialAppearanceMode="system"
        initialDefaultNewThreadFullAccess={false}
        initialTaskCompletionAlerts={true}
        detectedCliPath="/opt/homebrew/bin/claude"
        onClose={onClose}
        onSave={onSave}
        onCopyEnvDiagnostics={onCopyEnvDiagnostics}
        onSendTestAlert={onSendTestAlert}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Copy terminal env diagnostics' }));
    expect(onCopyEnvDiagnostics).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Send test alert' }));
    expect(onSendTestAlert).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    await user.click(screen.getByRole('button', { name: 'Use detected path' }));
    await user.click(screen.getByRole('switch', { name: /Start new threads with Full access/i }));
    await user.click(screen.getByRole('switch', { name: /Task completion alerts/i }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      cliPath: '/opt/homebrew/bin/claude',
      appearanceMode: 'dark',
      defaultNewThreadFullAccess: true,
      taskCompletionAlerts: false
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
