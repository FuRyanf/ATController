import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => true)
}));

vi.mock('@tauri-apps/api/core', () => coreMocks);

import {
  sendDesktopNotification,
  sendTaskCompletionAlert,
  sendTaskCompletionAlertsEnabledConfirmation,
  sendTaskCompletionAlertsTestNotification
} from '../../src/lib/taskCompletionAlerts';

describe('task completion alerts', () => {
  beforeEach(() => {
    coreMocks.invoke.mockClear();
    coreMocks.invoke.mockResolvedValue(true);
  });

  it('sends desktop notifications through the native bridge', async () => {
    const result = await sendDesktopNotification('Title', 'Body');

    expect(result).toBe(true);
    expect(coreMocks.invoke).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'Title',
      body: 'Body'
    });
  });

  it('formats completion and confirmation notifications correctly', async () => {
    await sendTaskCompletionAlert({
      threadTitle: 'Refactor thread',
      status: 'Succeeded'
    });
    await sendTaskCompletionAlertsEnabledConfirmation();
    await sendTaskCompletionAlertsTestNotification();

    expect(coreMocks.invoke).toHaveBeenNthCalledWith(1, 'send_desktop_notification', {
      title: 'Your task "Refactor thread" finished',
      body: 'Claude is ready.'
    });
    expect(coreMocks.invoke).toHaveBeenNthCalledWith(2, 'send_desktop_notification', {
      title: 'ATController alerts enabled',
      body: 'You will now get a notification when Claude finishes a task.'
    });
    expect(coreMocks.invoke).toHaveBeenNthCalledWith(3, 'send_desktop_notification', {
      title: 'ATController test alert',
      body: 'If you can see and hear this, alerts are working.'
    });
  });
});
