# ATController Technology Notes

This document describes ATController’s runtime architecture.

## Application Identity

- Product name: `ATController`
- macOS bundle: `ATController.app`
- Bundle identifier: `com.furyanf.atcontroller`
- Application data: `~/Library/Application Support/ATController/`
- Release artifacts: `ATController.dmg` and `ATController.app.zip`

This application identity and data directory are fixed. OpenAI Codex CLI is the only supported runtime.

## Architecture

ATController has three local layers:

- React and TypeScript frontend under `src/`
- Tauri command bridge and persistence in `src-tauri/src/`
- Rust PTY engine backed by `portable_pty`

The PTY output is rendered with xterm.js. ATController does not implement a separate model API client.

## Core Runtime Flow

1. The frontend selects a workspace thread.
2. The frontend invokes the terminal start command with the workspace, thread, and permission mode.
3. The backend resolves the configured or detected `codex` executable.
4. The backend launches the user’s login shell with `$SHELL -lic`, falling back to `/bin/zsh`.
5. The shell starts one of these interactive Codex commands:
   - `codex [permission flags]` for a new session
   - `codex [permission flags] resume <session-id>` for a saved local session
   - `codex [permission flags] fork <session-id>` when forking a local session
6. The backend streams PTY output to the run log and frontend terminal events.
7. The frontend applies ordered chunks to xterm.js.

Permission flags are explicit:

- Workspace mode: `--sandbox workspace-write --ask-for-approval on-request`
- Full access: `--dangerously-bypass-approvals-and-sandbox`

## Terminal Stream Contract

The backend assigns monotonic stream positions to output:

- `TerminalDataEvent { startPosition, endPosition, data }`
- `TerminalOutputSnapshot { text, startPosition, endPosition, truncated }`

Snapshot hydration and live output are phase-separated:

1. Bind the selected terminal session.
2. Buffer live chunks while reading the snapshot.
3. Apply the snapshot once.
4. Replay only chunks beyond the snapshot’s `endPosition`.
5. Continue with ordered live chunks.

`TerminalPanel` is the only production xterm writer. The session stream reducer owns ordering, duplicate suppression, and hydration boundaries.

The backend waits for the PTY reader, syncs the output file, and persists the final stream position before emitting terminal exit.

## Session Discovery

Codex session import scans rollout files under:

- `$CODEX_HOME/sessions/**/rollout-*.jsonl` when `CODEX_HOME` is set
- `~/.codex/sessions/**/rollout-*.jsonl` otherwise

ATController reads local Codex session metadata for discovery, workspace matching, resume, fork, and completion state. Import does not rewrite the source rollout files.

ATController does not inspect JSONL on remote SSH or rdev hosts. Automatic session-ID persistence, resume, fork detection, and semantic completion tracking are therefore best-effort local features and are not guaranteed for remote threads.

## Persistence Layout

ATController-owned state remains under:

```text
~/Library/Application Support/ATController/
```

The main layout is:

```text
workspaces.json
settings.json
threads/<workspaceId>/<threadId>/thread.json
threads/<workspaceId>/<threadId>/runs/<runId>/input_manifest.json
threads/<workspaceId>/<threadId>/runs/<runId>/output.log
threads/<workspaceId>/<threadId>/runs/<runId>/metadata.json
```

Thread metadata persists the Codex session ID, permission mode, enabled skills, activity timestamps, and fork state. Live PTY process identifiers remain runtime-only.

The first launch after upgrading performs a versioned migration in this same directory. It preserves existing workspace and thread data, resets legacy `fullAccess: true` thread values and `defaultNewThreadFullAccess: true` settings to `false`, then atomically records `migrations/codex-only-v1.json`. Malformed legacy JSON encountered during this migration is atomically quarantined with a `.codex-only-v1.invalid` suffix so it cannot remain active; malformed settings and workspace indexes are recreated with safe defaults. A failed or interrupted migration does not write the completion marker and is retried on the next startup. Once the marker exists, newly corrupted active files fail to load and are not silently overwritten.

`ATCONTROLLER_APP_SUPPORT_ROOT` is available only in debug and test builds for isolated fixtures. Production builds ignore it and always use `~/Library/Application Support/ATController/`.

### Runtime Log Retention

For active terminal sessions, ATController atomically compacts an `output.log` when it would exceed 8 MiB, retaining its most recent 6 MiB. Logical stream positions remain monotonic across compaction so reconnect snapshots can report omitted output correctly.

ATController keeps the newest 32 UUID-named thread run directories per thread and the newest 32 UUID-named workspace-shell session directories per workspace. The latest recorded thread run and directories marked by a live ATController process are protected even when they fall outside the newest-32 window. This policy applies only to ATController-owned runtime history and does not modify Codex session history under `$CODEX_HOME`.

## Workspace Semantics

ATController supports local, SSH, and rdev workspaces.

- A local workspace starts Codex on the Mac.
- A remote workspace starts the configured shell connection and then invokes Codex in that environment.
- Remote environments use their own Codex installation, authentication, configuration, and session history.
- Remote threads do not promise durable automatic resume because ATController cannot inspect the remote Codex rollout files.

Removing a workspace stops its active terminal sessions, removes its registration, and removes ATController’s thread storage for that workspace.

## Skills

Skill discovery scans:

- `<workspace>/.agents/skills/`
- `~/.agents/skills/`

Selected skill context is assembled locally and added to the next prompt. The Codex CLI remains responsible for executing the session.

## Git Integration

`src-tauri/src/git_tools.rs` provides:

- branch listing
- status summaries
- branch checkout
- optional pull-before-start behavior

Before branch switching, ATController shuts down workspace terminal sessions so a running process cannot remain attached to the previous checkout state.

## Keyboard and Terminal Behavior

- `Cmd+C` follows native macOS copy behavior in the embedded terminal.
- `Ctrl+C` sends the interrupt sequence to the active Codex PTY.
- Enter, resize, streaming, and ANSI behavior are passed through the PTY rather than translated into a chat API.

## Release Build

The release workflow builds `aarch64-apple-darwin`, verifies a thin `arm64` executable, checks the bundle name and identifier, verifies the DMG and ZIP, and publishes:

```text
ATController.dmg
ATController.app.zip
```

Pull-request, `main`, and manually dispatched builds are unsigned development artifacts. The fresh version-tag release job receives Apple credentials only through the protected `production` environment and fails closed unless every required signing and notarization secret is present.

Before a tag can publish, CI verifies the bundle identifier and version, the expected Apple Team ID, the native Apple silicon architecture, strict code-signature validity, Gatekeeper acceptance, stapled notarization tickets, DMG integrity, and the exact two release artifact names.

## Maintainer Invariants

- Keep `ATController` as the product name everywhere.
- Keep application data under `~/Library/Application Support/ATController/`.
- Keep Codex CLI as the only runtime.
- Do not add a second terminal content source outside the session stream reducer and `TerminalPanel`.
- Preserve monotonic stream positions across snapshot hydration and live replay.
- Attempt durable output sync before terminal exit, and surface any persistence failure in both the run state and exit event.
- Treat full access as an explicit thread or new-thread-default opt-in that bypasses Codex approvals and sandboxing.
- Validate terminal changes with automated tests and the live checklist in `docs/manual-terminal-rendering.md`.
