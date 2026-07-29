import { useEffect, useRef } from 'react';

import type { CodexThread, CodexThreadUiMetadata, Workspace } from '../types';
import { AppIcon, type AppIconName } from './AppIcon';

export type ThreadMenuAction =
  | 'open'
  | 'rename'
  | 'pin'
  | 'markRead'
  | 'copyId'
  | 'copyResume'
  | 'copyFullAccessResume'
  | 'openResumeInTerminal'
  | 'openProjectInTerminal'
  | 'revealProject'
  | 'restartRuntime'
  | 'startFresh'
  | 'fork'
  | 'archive'
  | 'unarchive'
  | 'delete';

interface ThreadContextMenuProps {
  thread: CodexThread;
  workspace: Workspace;
  metadata?: CodexThreadUiMetadata;
  x: number;
  y: number;
  onAction: (action: ThreadMenuAction) => void;
  onClose: () => void;
}

interface MenuItem {
  action: ThreadMenuAction;
  label: string;
  icon: AppIconName;
  danger?: boolean;
  separator?: boolean;
}

export function ThreadContextMenu({
  thread,
  workspace,
  metadata,
  x,
  y,
  onAction,
  onClose
}: ThreadContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const closeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeKey);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  const items: MenuItem[] = [
    { action: 'open', label: 'Open', icon: 'chevronRight' },
    { action: 'rename', label: 'Rename…', icon: 'code' },
    { action: 'pin', label: metadata?.pinned ? 'Unpin' : 'Pin', icon: 'pin' },
    { action: 'markRead', label: metadata?.unread ? 'Mark Read' : 'Mark Unread', icon: 'check' },
    { action: 'copyId', label: 'Copy Thread ID', icon: 'copy', separator: true },
    { action: 'copyResume', label: 'Copy Resume Command', icon: 'copy' },
    { action: 'copyFullAccessResume', label: 'Copy Full Access Resume Command', icon: 'copy' },
    { action: 'openResumeInTerminal', label: 'Open Resume Command in Terminal', icon: 'terminal' },
    {
      action: 'openProjectInTerminal',
      label: 'Open Project Terminal',
      icon: 'terminal',
      separator: true
    },
    { action: 'revealProject', label: 'Reveal Project in Finder', icon: 'folder' },
    { action: 'restartRuntime', label: 'Restart Codex Runtime', icon: 'refresh', separator: true },
    { action: 'startFresh', label: 'Start Fresh From This Project', icon: 'add' },
    { action: 'fork', label: 'Fork From Latest Turn', icon: 'history' },
    thread.archived
      ? { action: 'unarchive', label: 'Restore Thread', icon: 'history', separator: true }
      : { action: 'archive', label: 'Archive', icon: 'archive', separator: true },
    { action: 'delete', label: 'Delete…', icon: 'trash', danger: true }
  ];

  const left = Math.min(x, window.innerWidth - 310);
  const top = Math.min(y, window.innerHeight - 570);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={`Actions for ${thread.title}`}
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
        ];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let next = current;
        if (event.key === 'ArrowDown') next = (Math.max(0, current) + 1) % buttons.length;
        else if (event.key === 'ArrowUp') {
          next = (current <= 0 ? buttons.length : current) - 1;
        } else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      <div className="context-menu-heading">
        <strong>{thread.title}</strong>
        <span>{workspace.name}</span>
      </div>
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={`${item.danger ? 'danger' : ''} ${item.separator ? 'separator' : ''}`}
          onClick={() => {
            onAction(item.action);
            onClose();
          }}
        >
          <AppIcon name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
