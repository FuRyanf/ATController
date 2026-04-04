import { invoke } from '@tauri-apps/api/core';

import type { RunStatus } from '../types';

interface TaskCompletionAlertOptions {
  threadTitle: string;
  status: Extract<RunStatus, 'Succeeded' | 'Failed'>;
}

function alertCopy(status: Extract<RunStatus, 'Succeeded' | 'Failed'>, threadTitle: string) {
  const normalizedTitle = threadTitle.trim() || 'Current thread';
  if (status === 'Succeeded') {
    return {
      title: `Your task "${normalizedTitle}" finished`,
      body: 'Claude is ready.'
    };
  }

  return {
    title: `Your task "${normalizedTitle}" failed`,
    body: 'Claude ended with an error.'
  };
}

export async function sendDesktopNotification(title: string, body: string): Promise<boolean> {
  try {
    return await invoke<boolean>('send_desktop_notification', { title, body });
  } catch {
    return false;
  }
}

export async function sendTaskCompletionAlert({
  threadTitle,
  status
}: TaskCompletionAlertOptions): Promise<boolean> {
  const { title, body } = alertCopy(status, threadTitle);
  return await sendDesktopNotification(title, body);
}

export async function sendTaskCompletionAlertsEnabledConfirmation(): Promise<boolean> {
  return await sendDesktopNotification(
    'Claudex alerts enabled',
    'You will now get a notification when Claude finishes a task.'
  );
}

export async function sendTaskCompletionAlertsTestNotification(): Promise<boolean> {
  return await sendDesktopNotification(
    'Claudex test alert',
    'If you can see and hear this, alerts are working.'
  );
}
