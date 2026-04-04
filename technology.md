# ATController Technology Notes

This file documents the current implementation as of v0.1.10.

## Architecture

ATController has three layers:

- Frontend: React + TypeScript (`src/`)
- Backend bridge: Tauri commands (`src-tauri/src/main.rs`)
- Runtime engine: Rust PTY runner + storage (`src-tauri/src/runner.rs`, `src-tauri/src/storage.rs`)

The app launches the local Claude CLI in a real pseudo-terminal and renders it with xterm.js.

## Core Runtime Flow

1. Frontend selects a thread.
2. `terminal_start_session` is invoked with workspace path, thread id, and thread full-access flag.
3. Backend determines whether to start a new Claude session or resume an existing Claude session id.
4. Backend launches login shell (`$SHELL -lic`, fallback `/bin/zsh`) and runs:
   - `claude --session-id <uuid>` for new sessions
   - `claude --resume <uuid>` for resumed sessions
   - adds `--dangerously-skip-permissions` when thread full access is enabled
5. Backend streams PTY output to:
   - per-run `output.log`
   - `terminal:data` events for the frontend
6. Frontend writes stream chunks into xterm.

## Terminal Rendering (Current)

Backend buffering:

- PTY chunks are emitted with time/size buffering (`TERMINAL_EVENT_FLUSH_INTERVAL_MS`, `TERMINAL_EVENT_BUFFER_SIZE`).

Frontend buffering:

- `TerminalPanel` uses buffered writes with small flush windows:
  - `OUTPUT_FLUSH_MS = 8`
  - `OUTPUT_CHUNK_SIZE = 16 * 1024`
- Input is also coalesced before `terminal_write`:
  - `INPUT_FLUSH_MS = 8`
  - immediate flush on Enter, Ctrl-C, or input size threshold

Important behavior:

- Terminal open/switch hydrates from saved snapshot content and then continues with live stream.
- Stream data is currently passed through raw (no startup text suppression/filtering).

## Persistence Layout

Stored at:

- `~/Library/Application Support/ATController/`

Important files:

- `workspaces.json`
- `settings.json`
- `threads/<workspaceId>/<threadId>/thread.json`
- `threads/<workspaceId>/<threadId>/runs/<runId>/input_manifest.json`
- `threads/<workspaceId>/<threadId>/runs/<runId>/output.log`
- `threads/<workspaceId>/<threadId>/runs/<runId>/metadata.json`

`thread.json` stores resume metadata such as `claudeSessionId`, `lastResumeAt`, and `lastNewSessionAt`.

## Session / Thread Semantics

- Thread lifecycle (`rename`, `archive`, `delete`) is metadata/persistence based.
- Active PTY session state is runtime-only (`runStore` mapping thread -> runtime session id).
- Resume failures are detected heuristically and surfaced to the user with a fresh-start option.

## Workspace Semantics

- Workspace add/remove is persisted in `workspaces.json`.
- Removing a workspace now:
  - stops active terminal sessions for that workspace
  - removes workspace registration
  - removes workspace thread storage under `threads/<workspaceId>`

## Git Integration

`git_tools.rs` handles:

- branch listing
- status summaries
- checkout
- create-and-checkout (backend capability; not currently exposed in the branch switcher UI)
- optional `git pull` pre-step on `master` for new threads when workspace setting is enabled

Before branch switching, workspace terminal sessions are shut down to prevent process/branch mismatch.

## Keyboard Behavior

- `Cmd+C` follows native macOS copy behavior in the embedded terminal.
- `Ctrl+C` sends `SIGINT` to the active terminal session.

## Notes for Future Terminal Work

When changing terminal behavior, validate manually:

- cold start open (screen paints correctly without typing)
- thread switch while output is active
- fast streaming + scroll behavior
- resume/new session parity
- persisted snapshot correctness after process exit
