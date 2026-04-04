# ATController

ATController is a native macOS desktop app that wraps the local Claude Code CLI in a purpose-built control plane.

The app does not call Anthropic APIs directly. It launches your local `claude` binary in a real PTY, renders terminal output in-app, and keeps thread/session state on your machine.

Most UI actions map directly to local CLI or git behavior. The main exception is explicit convenience context that you opt into: selected skills and queued attachments are prepended locally before your next submitted prompt.

## Highlights

- Workspace + thread management across local and `ssh` workspaces.
- One-click thread start/resume with per-thread `Full access`, agent, and skills settings.
- Session import for existing Claude conversations, including bulk import from local Claude storage.
- Built-in file/image attachments, unread dots, task-completion notifications, and Dock badge counts.
- Git-aware branch switching plus optional `git checkout master && git pull` before new threads.
- Redesigned in-app settings for Claude path detection, diagnostics, and defaults.

## Security Model

ATController is a local wrapper around the existing Claude CLI, not a remote execution service.

- Runs `claude` locally under your current macOS user account and permissions.
- Does not proxy requests through an ATController backend service.
- Keeps `Full access` explicit and per-thread (default is off).
- Stores app data locally under `~/Library/Application Support/ATController/`.

Security boundary note: this app is **not** an OS sandbox for Claude. If Claude (or shell commands it runs) can access something in your normal terminal session, the same access level applies here.

For implementation details and tradeoffs, see [Security Notes (Detailed)](#security-notes-detailed).

## Why This Exists

Using Claude only in Terminal works well for one repo/thread, but gets painful when you juggle many:

- Too many tabs/windows across projects, with no single thread/workspace view.
- Session continuity is manual (resume ids and logs are easy to lose track of).
- Project operations (switching branches, opening folders, jumping threads) are fragmented.
- Per-thread runtime controls (like `Full access`) are harder to manage consistently.

ATController solves this by keeping Claude CLI local while adding a desktop control plane:

- Workspace + thread management in one left rail.
- Local and remote workspaces in one UI, with SSH sessions scoped to each thread.
- One-click normal or `Full access` thread start/resume for thread-scoped Claude sessions.
- Import existing Claude sessions individually or in bulk.
- Embedded PTY terminal behavior (ANSI, keyboard, streaming) with local log persistence.
- Attachment workflow for prompts: click `+` or drag files/images into the bottom bar, then send with your next Enter submit.
- Built-in project helpers (open folder/terminal, git branch/status context, optional pull-on-master startup).
- Optional per-thread controls like `Full access`, agent selection, and skills.
- Background completion signals via unread dots, desktop notifications, and Dock badge counts.

## Core Concepts

### Workspace

A workspace is the execution root for Claude and related shell operations.

Supported workspace types:

- `local`
- `ssh`

Remote workspaces store connection details in ATController, but Claude still runs in the shell environment you connect to.

### Thread

A thread is a named Claude conversation inside a workspace.

Each thread stores thread-scoped metadata such as:

- Claude session id
- `Full access` state
- enabled skills
- last activity timestamps

Deleting a thread removes ATController metadata and logs. It does not delete the underlying Claude conversation if you still know the session id.

### Run

A run is a concrete terminal/process instance under a thread. Runs write logs under the thread's `runs/` directory and are separate from persisted thread metadata.

## Quick Start (No Dev Setup)

This path is for end users. You only need:

- macOS
- Claude CLI installed (`claude` on PATH, or set the path in-app)

You do **not** need Node.js, Yarn, or Rust for this install flow.

Download, install, trust, and launch the latest build in one command:

```bash
bash -lc 'set -euo pipefail; DMG="$HOME/Downloads/ATController.dmg"; curl -fL -o "$DMG" "https://github.com/FuRyanf/ATController/releases/latest/download/ATController.dmg"; VOL="$(hdiutil attach "$DMG" -nobrowse | sed -n '\''s|^.*\(/Volumes/.*\)$|\1|p'\'' | head -n 1)"; trap '\''hdiutil detach "$VOL" -quiet >/dev/null 2>&1 || true'\'' EXIT; ditto "$VOL/ATController.app" "/Applications/ATController.app"; xattr -dr com.apple.quarantine "/Applications/ATController.app" || true; open "/Applications/ATController.app"'
```

Prebuilt release note:

- Releases publish a macOS DMG and app ZIP via GitHub Actions.
- If you hit machine-specific compatibility issues, build from source locally (`yarn tauri build`) for your environment.

## Product Features

### Import Existing Sessions

ATController supports two import flows:

- Manual import by Claude session id from a workspace context menu.
- Bulk import from local Claude history under `~/.claude/projects`.

Bulk import can automatically add missing local projects first, skip already-imported sessions, and import multiple sessions in one pass.

### Alerts, Dock Badge, and Updates

ATController can surface background thread completion through:

- unread dots in the left rail
- macOS task completion alerts
- Dock badge counts for unread threads

When a newer release is available, ATController can also install updates in place from inside the app.

### Settings

The Settings UI covers the main app-level controls:

- appearance mode: System, Light, or Dark
- task completion alerts and a test alert action
- Claude CLI path override and detected-path fallback
- default new-thread `Full access` behavior
- terminal environment diagnostics copy action

## Development Requirements (Source Build Only)

- Node.js + Yarn
- Rust toolchain (for Tauri build)
- Claude CLI installed (`claude` on PATH or configured in app settings)

## Install

```bash
yarn install --ignore-engines
```

## Run In Development

```bash
yarn tauri dev
```

Optional frontend-only dev server:

```bash
yarn dev
```

## Build

```bash
yarn build
yarn tauri build
```

Built app output:

- `/Users/you/project-root/src-tauri/target/release/bundle/macos/ATController.app`

## Downloads

- Latest public build:
  - [Latest release](https://github.com/FuRyanf/ATController/releases/latest)
  - [Direct DMG download](https://github.com/FuRyanf/ATController/releases/latest/download/ATController.dmg)
- CI build runs (every push to `master`/`main`, every PR targeting `master`/`main`, and every `v*` tag push):
  - [Build workflow runs](https://github.com/FuRyanf/ATController/actions/workflows/build-macos.yml)
  - Each run publishes `ATController.dmg` and `ATController.app.zip` as artifacts (artifact retention is time-limited by GitHub Actions).
- For `v*` tags, the same DMG and ZIP are attached to the GitHub Release automatically.
- If signing secrets are not configured, builds are unsigned. macOS Gatekeeper may show a warning on first launch. Use Finder `Open` (or `System Settings > Privacy & Security > Open Anyway`) to run the app.

## Developer ID Signing (GitHub Actions)

The workflow supports optional macOS Developer ID signing and notarization when these repository secrets are configured:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: password for that `.p12`
- `APPLE_SIGNING_IDENTITY`: certificate common name (for example `Developer ID Application: Your Name (TEAMID)`)
- `APPLE_ID`: Apple ID email used for notarization
- `APPLE_PASSWORD`: app-specific password for that Apple ID
- `APPLE_TEAM_ID`: Apple Developer Team ID
- `KEYCHAIN_PASSWORD` (optional): temporary CI keychain password

When these are present, CI imports the certificate into a temporary keychain and Tauri signs/notarizes during `tauri build`.  
When they are absent, CI still builds unsigned artifacts.

## Data Storage

ATController stores data under:

- `~/Library/Application Support/ATController/`

Important files/directories:

- `workspaces.json`
- `settings.json`
- `threads/<workspaceId>/<threadId>/thread.json`
- `threads/<workspaceId>/<threadId>/runs/<runId>/output.log`
- `threads/<workspaceId>/<threadId>/runs/<runId>/metadata.json`

Backing up this directory preserves ATController metadata, thread state, and local run logs.

## Security Notes (Detailed)

Current controls:

- Workspace and run paths are normalized and validated before use, with path-segment checks on workspace/thread ids to reduce traversal-style file access bugs.
- Terminal launch commands are constructed with escaping and UUID session ids, reducing shell argument injection risk around the Claude binary path/session id.
- `Full access` is only enabled when explicitly set on a thread; default thread creation keeps it off.
- Diagnostics output applies redaction heuristics for common secret-like environment variable names before writing diagnostics artifacts.
- Git helpers run with non-interactive prompts disabled and include command timeouts.
- Skills and queued attachments are only prepended when you explicitly select or stage them.

Known limitations:

- ATController is not a sandbox and does not reduce the privileges of your local user account.
- Thread transcripts, run manifests, and terminal logs are local plaintext files; sensitive content may be persisted.
- If `Full access` is enabled, Claude launches with `--dangerously-skip-permissions`.
- App-level hardening can be improved further (for example, tightening CSP and narrowing exposed command surface over time).

## Core Runtime Model

- Workspace and thread list state is driven by persisted thread metadata.
- Selecting/opening a thread starts or resumes a PTY session for that thread.
- Threads are first-class entities; runs are children under each thread.
- Thread actions (`Rename`, `Archive`, `Delete`) mutate thread metadata/persistence only.
- Per-thread `Full access` state is persisted and applied at session start.

## Technology

ATController is a three-layer local architecture:

- Frontend (`React` + `TypeScript`): manages workspace/thread UX and terminal hydration state.
- Backend (`Tauri` + `Rust`): exposes command handlers for thread persistence, PTY control, git, and settings.
- PTY layer (`portable_pty` + local shell): runs Claude in an actual pseudo-terminal and streams bytes to the UI.

For deeper implementation details (runtime flow, buffering/hydration, and operational notes), see [`technology.md`](technology.md).

Claude is started through `terminal_start_session`, which launches your login shell as `$SHELL -lic` (fallback `/bin/zsh`) and runs either:

- `claude --session-id <uuid>` for a new thread session
- `claude --resume <uuid>` for a resumed thread session
- optional `--dangerously-skip-permissions` when thread `Full access` is enabled

Terminal rendering is PTY-native: Rust reads PTY output, appends to `output.log`, emits `terminal:data` events, and the UI writes buffered chunks into `xterm.js`. On open/switch, the app hydrates from a snapshot (`terminal_read_output` / `terminal_get_last_log`) instead of replaying historical events, and temporarily defers live `terminal:data` appends for that session until snapshot hydration completes.

Session resume is thread-scoped. `thread.json` stores `claudeSessionId`, `lastResumeAt`, and `lastNewSessionAt`; startup decides new vs resumed mode from this metadata (with log-based session-id recovery fallback). If resume likely failed, the UI offers `Start fresh` (clears the saved Claude session id, then restarts).

Threads are persisted independently of live PTY processes (`thread.json` + `runs/<runId>/output.log` + `runs/<runId>/metadata.json`), so thread actions update metadata without coupling to transient runtime state.

Git integration is local CLI based (`git_tools.rs`): branch/status polling, branch checkout from the UI, optional per-workspace git pull pre-step for new threads, and workspace-safe session shutdown around checkout operations.

Why it stays fast:

- Minimal overhead: local CLI + PTY, no API proxy layer.
- No transcript replay requirement to paint terminal state.
- Streaming is buffered on both sides (Rust event buffering + frontend xterm buffered writes).
- State is structured by thread/workspace maps (`threadStore` for persisted metadata, `runStore` for live sessions) with refs for hot paths to avoid broad rerenders.
- Rendering avoids jitter through memoized sidebar components, resize/input debouncing, and imperative terminal writes instead of React-driven text repainting.

Local app data lives at `~/Library/Application Support/ATController/` (workspaces, settings, thread metadata, run logs/manifests).

## Resume Behavior (High Level)

- Each thread can persist a Claude session id in `thread.json`.
- On thread open/start:
  - With prior Claude session id: launches `claude --resume <sessionId>`
  - Without one: generates a UUID and launches `claude --session-id <generatedId>`
- Startup uses login shell parity (`$SHELL -lic`, fallback `/bin/zsh`) so env/path behavior matches Terminal.
- If `Full access` is enabled for a thread, startup appends `--dangerously-skip-permissions`.

## Icons

Canonical source image:

- `/Users/you/project-root/app icon.jpg`

Generated base icon:

- `/Users/you/project-root/assets/icon.png`

Regenerate all icons:

```bash
yarn generate:icons
```

This updates platform icons under:

- `/Users/you/project-root/src-tauri/icons`
- `/Users/you/project-root/src-tauri/icons/macos`

## Verification

UI tests:

```bash
yarn test:ui
```

Full app build:

```bash
yarn tauri build
```

Optional local verification loop:

```bash
make verify
```

`make verify` runs frontend build, UI tests, Rust tests, and a Claude PTY smoke test, then writes logs under `artifacts/e2e/`.
It also writes a summary report to `artifacts/last_diagnosis.txt`.

## Troubleshooting

### Claude CLI path not detected

- Open app `Settings`.
- Set `Claude CLI Path` explicitly (for example `/usr/local/bin/claude` or your local install path).
- Re-open a thread to start a new PTY session.

### MCP works in Terminal but not in ATController

- Confirm ATController launches via login shell path (`$SHELL -lic`) by using the in-app diagnostics copy action.
- Compare PATH/env output between ATController diagnostics and native Terminal.
- Ensure shell startup files that initialize MCP dependencies are valid (`~/.zprofile`, `~/.zshrc`, etc.).

### Permissions and Full Access mode

- Default behavior is standard Claude permission prompts.
- Enable `Full access` per-thread to launch with `--dangerously-skip-permissions`.
- Toggling `Full access` restarts the current thread session so the new mode takes effect immediately.

### Remote workspaces (ssh)

- Add a remote project with a direct `ssh <host>` command.
- ATController opens SSH, then launches/resumes `claude` inside the remote shell for each thread.
- Remote sessions use the remote machine's `claude` binary and environment; verify that command works directly in your terminal if startup fails.

### Workspace add or picker issues

- Use `Add new project` and select a directory in the native folder picker.
- If picker fails/unavailable, use manual path entry in the fallback modal.
