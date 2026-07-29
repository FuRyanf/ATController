import { useEffect, useRef, useState } from 'react';

import type {
  BrowserAction,
  BrowserDiagnostics,
  BrowserSessionMetadata
} from '../types';
import { AppIcon } from './AppIcon';

interface BrowserMenuProps {
  session?: BrowserSessionMetadata;
  diagnostics: BrowserDiagnostics | null;
  busy: boolean;
  onAction: (action: BrowserAction) => void;
  onOpenCurrentPage: () => void;
  onCopyCurrentUrl: () => void;
  onOpenSetup: () => void;
  onOpenDiagnostics: () => void;
}

function stateLabel(session?: BrowserSessionMetadata): string {
  switch (session?.state) {
    case 'codexActive':
      return 'Codex active';
    case 'userActive':
      return 'User active';
    case 'starting':
      return 'Starting';
    case 'stopping':
      return 'Stopping';
    case 'ready':
      return 'Ready';
    case 'disconnected':
      return 'Disconnected';
    case 'failed':
      return 'Failed';
    case 'stopped':
    default:
      return 'Stopped';
  }
}

export function BrowserMenu({
  session,
  diagnostics,
  busy,
  onAction,
  onOpenCurrentPage,
  onCopyCurrentUrl,
  onOpenSetup,
  onOpenDiagnostics
}: BrowserMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const configured = diagnostics?.configuration.configured === true;
  const active = session && !['stopped', 'notConfigured', 'unavailable'].includes(session.state);
  const needsRecovery =
    session?.state === 'disconnected' || session?.state === 'failed';

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (
        event instanceof PointerEvent &&
        rootRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  const run = (action: BrowserAction) => {
    setOpen(false);
    onAction(action);
  };

  return (
    <div className="browser-menu" ref={rootRef}>
      <button
        type="button"
        className={`icon-button browser-menu-trigger ${active ? 'active' : ''}`}
        aria-label="Browser actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Browser · ${stateLabel(session)}`}
        onClick={() => setOpen((value) => !value)}
      >
        <AppIcon name="browser" />
        {active ? <span className={`browser-trigger-dot ${session?.state}`} /> : null}
      </button>
      {open ? (
        <div className="browser-menu-popover" role="menu">
          <header>
            <span className={`browser-state-dot ${session?.state ?? 'stopped'}`} />
            <div>
              <strong>Browser</strong>
              <small>{configured ? stateLabel(session) : 'Setup required'}</small>
            </div>
          </header>
          {!configured ? (
            <button type="button" role="menuitem" onClick={onOpenSetup}>
              <AppIcon name="gear" />
              Browser Setup
            </button>
          ) : !active ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run('open')}
            >
              <AppIcon name="browser" />
              Open Browser
            </button>
          ) : needsRecovery ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => run('restart')}
            >
              <AppIcon name="refresh" />
              Recover Browser Session
            </button>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => run('takeScreenshot')}
              >
                <AppIcon name="camera" />
                Take Screenshot
              </button>
              {session?.lastUrl ? (
                <>
                  <button type="button" role="menuitem" onClick={onOpenCurrentPage}>
                    <AppIcon name="browser" />
                    Open Current Page Externally
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onCopyCurrentUrl();
                    }}
                  >
                    <AppIcon name="copy" />
                    Copy Current URL
                  </button>
                </>
              ) : null}
              {session?.controlOwner === 'user' ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => run('returnToCodex')}
                >
                  <AppIcon name="check" />
                  Return to Codex
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => run('takeControl')}
                >
                  <AppIcon name="browser" />
                  Take Control
                </button>
              )}
              <div className="menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => run('restart')}
              >
                <AppIcon name="refresh" />
                Restart Browser Session
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => run('stop')}
              >
                <AppIcon name="stop" />
                Stop Browser Session
              </button>
            </>
          )}
          <div className="menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={onOpenSetup}>
            <AppIcon name="gear" />
            Browser Setup
          </button>
          <button type="button" role="menuitem" onClick={onOpenDiagnostics}>
            <AppIcon name="info" />
            Browser Diagnostics
          </button>
        </div>
      ) : null}
    </div>
  );
}
