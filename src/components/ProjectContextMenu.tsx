import { useEffect, useRef } from 'react';

import type { Workspace } from '../types';
import { AppIcon, type AppIconName } from './AppIcon';

export type ProjectMenuAction =
  | 'newThread'
  | 'openProject'
  | 'openTerminal'
  | 'revealFinder'
  | 'copyPath'
  | 'copyShellCommand'
  | 'refreshGit'
  | 'importThreads'
  | 'rename'
  | 'changeIcon'
  | 'pin'
  | 'collapseOthers'
  | 'projectSettings'
  | 'locateFolder'
  | 'remove';

interface ProjectContextMenuProps {
  workspace: Workspace;
  hasGit: boolean;
  x: number;
  y: number;
  onAction: (action: ProjectMenuAction) => void;
  onClose: () => void;
}

interface MenuItem {
  action: ProjectMenuAction;
  label: string;
  icon: AppIconName;
  separator?: boolean;
  danger?: boolean;
}

export function ProjectContextMenu({
  workspace,
  hasGit,
  x,
  y,
  onAction,
  onClose
}: ProjectContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const closePointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const closeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', closePointer);
    window.addEventListener('keydown', closeKey);
    return () => {
      window.removeEventListener('pointerdown', closePointer);
      window.removeEventListener('keydown', closeKey);
    };
  }, [onClose]);

  const availableItems: MenuItem[] = [
    { action: 'newThread', label: 'New Thread', icon: 'add' },
    { action: 'openProject', label: 'Open Project', icon: 'chevronRight' },
    { action: 'openTerminal', label: 'Open in Terminal', icon: 'terminal', separator: true },
    { action: 'revealFinder', label: 'Reveal in Finder', icon: 'folder' },
    { action: 'copyPath', label: 'Copy Project Path', icon: 'copy' },
    { action: 'copyShellCommand', label: 'Copy Shell Command', icon: 'command' },
    ...(hasGit
      ? [{ action: 'refreshGit', label: 'Refresh Git Status', icon: 'refresh' } as MenuItem]
      : []),
    { action: 'importThreads', label: 'Import Codex Threads', icon: 'history', separator: true },
    { action: 'rename', label: 'Rename Display Name…', icon: 'code' },
    { action: 'changeIcon', label: 'Change Icon…', icon: 'folder' },
    { action: 'pin', label: workspace.isPinned ? 'Unpin Project' : 'Pin Project', icon: 'pin' },
    { action: 'collapseOthers', label: 'Collapse Other Projects', icon: 'chevronRight' },
    { action: 'projectSettings', label: 'Project Settings…', icon: 'gear' },
    {
      action: 'remove',
      label: 'Remove from ATController…',
      icon: 'trash',
      separator: true,
      danger: true
    }
  ];
  const missingItems: MenuItem[] = [
    { action: 'locateFolder', label: 'Locate Folder…', icon: 'folder' },
    { action: 'copyPath', label: 'Copy Original Path', icon: 'copy' },
    { action: 'rename', label: 'Rename Display Name…', icon: 'code', separator: true },
    { action: 'projectSettings', label: 'Project Settings…', icon: 'gear' },
    {
      action: 'remove',
      label: 'Remove from ATController…',
      icon: 'trash',
      separator: true,
      danger: true
    }
  ];
  const items = workspace.isAvailable ? availableItems : missingItems;
  const left = Math.max(8, Math.min(x, window.innerWidth - 310));
  const top = Math.max(8, Math.min(y, window.innerHeight - 590));

  return (
    <div
      ref={ref}
      className="context-menu project-context-menu"
      role="menu"
      aria-label={`Actions for ${workspace.name}`}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          buttons[(Math.max(current, -1) + 1) % buttons.length]?.focus();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          buttons[(current <= 0 ? buttons.length : current) - 1]?.focus();
        } else if (event.key === 'Home') {
          event.preventDefault();
          buttons[0]?.focus();
        } else if (event.key === 'End') {
          event.preventDefault();
          buttons[buttons.length - 1]?.focus();
        }
      }}
    >
      <div className="context-menu-heading">
        <strong>{workspace.name}</strong>
        <span title={workspace.path}>{workspace.path}</span>
      </div>
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={`${item.separator ? 'separator' : ''} ${item.danger ? 'danger' : ''}`}
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
