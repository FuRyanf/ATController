# Known Issues

## Unsigned Development Builds

Pull-request, `main`, and manually dispatched workflows build ATController without Apple signing credentials. macOS Gatekeeper may block an unsigned development artifact on first launch.

Version-tag builds require Developer ID signing and notarization credentials and fail before publication if they are unavailable. Only production release artifacts are intended for normal installation.

## Terminal Rendering Differences

ATController renders the Codex terminal UI through xterm.js. Font metrics, Unicode width rules, and rapid cursor redraws can differ slightly from Terminal.app.

If the display becomes stale or misaligned:

1. Resize the ATController window.
2. Switch to another thread and back.
3. Use the terminal refresh action.

Report reproducible cases with the macOS version, Codex CLI version, terminal dimensions, and a redacted tail of the affected run’s `output.log`.

## Session Discovery Depends on Local Rollout Files

Bulk import discovers Codex sessions from `$CODEX_HOME/sessions/` or `~/.codex/sessions/`. Sessions stored under another Codex home, removed rollout files, and sessions that cannot be matched to a workspace may not appear.

Use manual import when you know the session ID, and confirm ATController is using the same `CODEX_HOME` as your terminal.

The recent-session sidebar uses the active local Codex session files, excludes archived sessions,
and assigns nested working directories to the deepest matching registered workspace. It may take
up to one minute for an external Codex CLI session to appear automatically; reopening the app
refreshes it immediately.

## Usage Availability

ATController displays only the 5-hour and weekly windows returned by the authenticated local Codex
CLI. Some account types or plans do not return both windows. An unavailable label means Codex did
not report that window; it is not a zero-usage estimate. Model and speed controls remain available
when usage cannot be read.

## Remote Environment Setup

SSH and rdev workspaces depend on the remote machine’s shell startup, Codex installation, authentication, and repository access. ATController cannot repair a remote login or Codex configuration that fails in a normal terminal.

Verify the connection command, `codex --version`, and `codex login status` directly on the remote environment before troubleshooting ATController.

ATController does not read Codex rollout JSONL from the remote host. Automatic session-ID persistence and durable resume are not guaranteed for SSH or rdev threads.

## Full Access

Full access launches Codex with `--dangerously-bypass-approvals-and-sandbox`. This disables Codex’s approval and sandbox protections for that thread.

Use Workspace mode unless the repository, instructions, tools, and execution environment are trusted.
