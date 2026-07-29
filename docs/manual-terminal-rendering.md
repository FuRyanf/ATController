# Manual Terminal Rendering Checklist

Record the macOS version, ATController version, Codex CLI version, Mac architecture, and tested workspace type with each manual run.

## Startup and Resume

1. Open a workspace thread with saved output without typing.
2. Confirm the latest screen paints immediately with no stale or blank frame.
3. Start a new thread and verify the Codex terminal UI accepts input.
4. Close and reopen the thread.
5. Confirm ATController resumes the same Codex session.
6. Use **Start fresh** and confirm a new session starts without altering the previous Codex rollout file.

## Permission Modes

1. Start a thread in Workspace mode.
2. Confirm Codex reports workspace-write sandboxing with on-request approvals.
3. Change the thread to Full access.
4. Confirm the session restarts and clearly reflects the full-access setting.
5. Return to Workspace mode before continuing routine tests.

## Scroll and Stream Stability

1. Produce enough output to fill several terminal screens.
2. Scroll away from the bottom while output is active.
3. Confirm existing lines remain stable and **Jump to latest** appears.
4. Resume following and confirm ordered output with no duplicated or missing chunks.
5. Switch threads during active output, then return and confirm hydration/live-stream continuity.

## Cursor Movement Output

Ask Codex to run:

```bash
for i in $(seq 1 120); do printf "line %03d quick stream output\n" "$i"; sleep 0.02; done
for i in $(seq 0 5 100); do printf "\rprogress %3d%%" "$i"; sleep 0.05; done; printf "\n"
```

Confirm delayed lines, wrapped output, cursor rewrites, and progress updates render cleanly.

## Large Burst Resilience

Ask Codex to run:

```bash
for i in $(seq 1 200); do printf "burst %03d ........................................................................\n" "$i"; done
```

Confirm ATController remains responsive and the terminal repaints without overlapping rows or frozen input.

## Resize

1. Resize the window repeatedly while output streams.
2. Enter and leave full-screen mode.
3. Collapse and restore adjacent panels when available.
4. Confirm the PTY refits, line wrapping remains coherent, and no resize loop or clipped canvas appears.

## Persistence

1. Let a command print a unique marker immediately before the Codex process exits.
2. Reopen the thread.
3. Confirm the marker exists in the rendered snapshot and the run’s `output.log`.
4. Confirm no output after the saved stream boundary is duplicated.

## Remote Workspaces

Repeat startup, input, interrupt, and resize checks in one SSH or rdev workspace. Confirm remote Codex authentication and session history remain remote. Do not treat automatic session-ID persistence or resume as a pass criterion for remote threads.

## Diagnostics

Open the webview developer console during the test. Confirm there are no terminal stream, resize, hydration, or unhandled React errors. Redact credentials, tokens, prompts, private paths, and repository content before sharing logs.
