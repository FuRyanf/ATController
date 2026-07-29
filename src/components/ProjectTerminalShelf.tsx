import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import * as apiModule from '../lib/api';
import { api } from '../lib/api';
import type {
  ProjectTerminalExit,
  ProjectTerminalOutput,
  ProjectTerminalSession,
  Workspace
} from '../types';
import { AppIcon } from './AppIcon';

const TERMINAL_HEIGHT_KEY = 'atcontroller:project-terminal-height-v1';
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 150;

interface ProjectTerminalShelfProps {
  open: boolean;
  workspace: Workspace | null;
  requestedCwd?: string | null;
  onClose: () => void;
  onError: (message: string) => void;
}

function releaseListener(listener: (() => void) | undefined): void {
  try {
    listener?.();
  } catch {
    // Tauri listeners can already be released during application teardown.
  }
}

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: color('--bg-code', '#1b1d20'),
    foreground: color('--text-primary', '#e8e9ea'),
    cursor: color('--accent', '#72a2dc'),
    cursorAccent: color('--bg-code', '#1b1d20'),
    selectionBackground: color('--accent-soft', 'rgba(114, 162, 220, 0.22)'),
    black: '#24262a',
    red: color('--danger', '#db7b75'),
    green: color('--success', '#7eb38d'),
    yellow: color('--warning', '#d0a060'),
    blue: color('--accent', '#72a2dc'),
    magenta: color('--purple', '#aa96d7'),
    cyan: '#72b7c3',
    white: color('--text-primary', '#e8e9ea'),
    brightBlack: color('--text-tertiary', '#73777c'),
    brightRed: '#ec918b',
    brightGreen: '#9ac8a6',
    brightYellow: '#dfb678',
    brightBlue: '#92bae7',
    brightMagenta: '#bdaae5',
    brightCyan: '#91cad2',
    brightWhite: '#ffffff'
  };
}

function decodeOutput(output: ProjectTerminalOutput): Uint8Array {
  const encoded = window.atob(output.dataBase64);
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index] = encoded.charCodeAt(index);
  }
  return bytes;
}

function exitLabel(exit: ProjectTerminalExit): string {
  if (exit.error) return exit.error;
  if (exit.signal) return `Exited after ${exit.signal}`;
  return `Exited with code ${exit.exitCode ?? 'unknown'}`;
}

export function ProjectTerminalShelf({
  open,
  workspace,
  requestedCwd,
  onClose,
  onError
}: ProjectTerminalShelfProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<ProjectTerminalSession | null>(null);
  const workspaceIdRef = useRef<string | null>(workspace?.id ?? null);
  const openRef = useRef(open);
  const onErrorRef = useRef(onError);
  const resizeFrameRef = useRef<number | null>(null);
  const inputChainRef = useRef<Promise<void>>(Promise.resolve());
  const [ready, setReady] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [session, setSession] = useState<ProjectTerminalSession | null>(null);
  const [status, setStatus] = useState<'connecting' | 'running' | 'exited'>('connecting');
  const [restartRevision, setRestartRevision] = useState(0);
  const [height, setHeight] = useState(() => {
    const stored = Number(window.localStorage.getItem(TERMINAL_HEIGHT_KEY));
    return Number.isFinite(stored) ? Math.max(MIN_HEIGHT, stored) : DEFAULT_HEIGHT;
  });

  workspaceIdRef.current = workspace?.id ?? null;
  openRef.current = open;
  onErrorRef.current = onError;

  const fit = () => {
    const terminal = terminalRef.current;
    const addon = fitRef.current;
    if (!terminal || !addon || !hostRef.current || !openRef.current) return;
    try {
      addon.fit();
      const active = sessionRef.current;
      if (active) {
        void api
          .resizeProjectTerminal(active.id, terminal.cols, terminal.rows)
          .catch(() => undefined);
      }
    } catch {
      // A transient zero-sized host during layout changes is harmless.
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily:
        '"SFMono-Regular", ui-monospace, "Cascadia Code", "Roboto Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      macOptionIsMeta: true,
      scrollback: 8_000,
      smoothScrollDuration: 0,
      theme: terminalTheme()
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    const input = terminal.onData((data) => {
      const active = sessionRef.current;
      if (active) {
        inputChainRef.current = inputChainRef.current
          .then(() => api.writeProjectTerminal(active.id, data))
          .catch((error) => {
            onErrorRef.current(`Project Terminal input failed: ${String(error)}`);
          });
      }
    });
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (resizeFrameRef.current != null) {
              cancelAnimationFrame(resizeFrameRef.current);
            }
            resizeFrameRef.current = requestAnimationFrame(fit);
          });
    resizeObserver?.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    setReady(true);

    return () => {
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopOutput: (() => void) | undefined;
    let stopExit: (() => void) | undefined;
    const attach = async () => {
      try {
        stopOutput = await apiModule.onProjectTerminalOutput((output) => {
          const active = sessionRef.current;
          if (
            output.workspaceId !== workspaceIdRef.current ||
            (active && output.sessionId !== active.id)
          ) {
            return;
          }
          terminalRef.current?.write(decodeOutput(output));
        });
        if (disposed) {
          releaseListener(stopOutput);
          return;
        }
        stopExit = await apiModule.onProjectTerminalExit((exit) => {
          const active = sessionRef.current;
          if (!active || exit.sessionId !== active.id) return;
          sessionRef.current = null;
          setSession(null);
          setStatus('exited');
          terminalRef.current?.writeln(
            `\r\n\u001b[38;5;244m[Project Terminal: ${exitLabel(exit)}]\u001b[0m`
          );
        });
        if (disposed) {
          releaseListener(stopOutput);
          releaseListener(stopExit);
          return;
        }
        setListenersReady(true);
      } catch (error) {
        releaseListener(stopOutput);
        releaseListener(stopExit);
        if (!disposed) {
          onErrorRef.current(
            `Could not attach Project Terminal events: ${String(error)}`
          );
        }
      }
    };
    void attach();
    return () => {
      disposed = true;
      releaseListener(stopOutput);
      releaseListener(stopExit);
    };
  }, []);

  useEffect(() => {
    if (!ready || !listenersReady || !open || !workspace) return;
    let cancelled = false;
    const connect = async () => {
      const previous = sessionRef.current;
      const requested = requestedCwd || workspace.path;
      if (
        previous &&
        previous.workspaceId === workspace.id &&
        previous.cwd === requested
      ) {
        requestAnimationFrame(fit);
        terminalRef.current?.focus();
        return;
      }
      if (previous) {
        await api.stopProjectTerminal(previous.id).catch(() => undefined);
        sessionRef.current = null;
        setSession(null);
      }
      setStatus('connecting');
      terminalRef.current?.reset();
      terminalRef.current?.writeln(
        `\u001b[38;5;244mOpening Project Terminal in ${workspace.name}…\u001b[0m`
      );
      requestAnimationFrame(fit);
      try {
        const terminal = terminalRef.current;
        const started = await api.startProjectTerminal(
          workspace.id,
          requested,
          terminal?.cols || 100,
          terminal?.rows || 24
        );
        if (cancelled) {
          await api.stopProjectTerminal(started.id).catch(() => undefined);
          return;
        }
        sessionRef.current = started;
        setSession(started);
        setStatus('running');
        requestAnimationFrame(() => {
          fit();
          terminalRef.current?.focus();
        });
      } catch (error) {
        if (cancelled) return;
        setStatus('exited');
        const message = `Could not open Project Terminal: ${String(error)}`;
        terminalRef.current?.writeln(`\r\n\u001b[31m${message}\u001b[0m`);
        onErrorRef.current(message);
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    ready,
    listenersReady,
    requestedCwd,
    restartRevision,
    workspace?.id,
    workspace?.path
  ]);

  useEffect(() => {
    if (open) requestAnimationFrame(fit);
  }, [height, open]);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = height;
    const move = (moveEvent: globalThis.PointerEvent) => {
      const maximum = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.68));
      setHeight(Math.min(maximum, Math.max(MIN_HEIGHT, startHeight + startY - moveEvent.clientY)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setHeight((current) => {
        window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(current));
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const terminate = async () => {
    const active = sessionRef.current;
    if (active) await api.stopProjectTerminal(active.id).catch(() => undefined);
    sessionRef.current = null;
    setSession(null);
    setStatus('exited');
    terminalRef.current?.writeln(
      '\r\n\u001b[38;5;244m[Project Terminal session stopped]\u001b[0m'
    );
  };

  const restart = async () => {
    const active = sessionRef.current;
    if (active) await api.stopProjectTerminal(active.id).catch(() => undefined);
    sessionRef.current = null;
    setSession(null);
    setRestartRevision((value) => value + 1);
  };

  const style = { '--project-terminal-height': `${height}px` } as CSSProperties;
  return (
    <section
      className={`project-terminal-shelf ${open ? 'open' : 'hidden'}`}
      style={style}
      aria-label="Project Terminal"
      aria-hidden={!open}
    >
      <div
        className="project-terminal-resizer"
        role="separator"
        aria-label="Resize Project Terminal"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
      />
      <header>
        <div className="project-terminal-identity">
          <AppIcon name="terminal" size={14} />
          <strong>Project Terminal</strong>
          <span className={`project-terminal-status ${status}`} />
          <span>{workspace?.name ?? 'No project'}</span>
          {session ? <small title={session.cwd}>{session.cwd}</small> : null}
        </div>
        <div className="project-terminal-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Clear Project Terminal"
            title="Clear"
            onClick={() => terminalRef.current?.clear()}
          >
            <AppIcon name="trash" size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Restart Project Terminal"
            title="Restart shell"
            onClick={() => void restart()}
          >
            <AppIcon name="refresh" size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Stop Project Terminal"
            title="Stop shell"
            disabled={!session}
            onClick={() => void terminate()}
          >
            <AppIcon name="stop" size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Hide Project Terminal"
            title="Hide Project Terminal (⌘J)"
            onClick={onClose}
          >
            <AppIcon name="close" size={13} />
          </button>
        </div>
      </header>
      <div ref={hostRef} className="project-terminal-host" />
    </section>
  );
}
