# Terminal Output Hardening Summary

## 1. Final architecture overview

The terminal pipeline now has one authoritative data flow:

1. The backend PTY reader appends every decoded chunk into a per-session output buffer.
2. That buffer assigns monotonic `startPosition` / `endPosition` values to every emitted `terminal:data` event.
3. The frontend stores per-session stream state in `TerminalSessionStreamState`, not in ad hoc string snapshots.
4. Snapshot hydration enters a `hydrating` phase, buffers live chunks, applies the snapshot once, then replays only chunks strictly beyond the snapshot boundary.
5. `TerminalPanel` is the only subsystem that writes to xterm. `App.tsx` now feeds it ordered stream state instead of maintaining a second terminal rendering truth.

Key pieces:

- Backend contract:
  - `TerminalDataEvent { startPosition, endPosition, data }`
  - `TerminalOutputSnapshot { text, startPosition, endPosition, truncated }`
- Frontend reducer:
  - `src/lib/terminalSessionStream.ts`
- Single xterm writer:
  - `src/components/TerminalPanel.tsx`

Exit durability is enforced in the backend: the wait thread now blocks on reader completion, syncs the output file, and persists `endPosition` into run `metadata.json` before emitting `terminal:exit`.

## 2. Enforced invariants

- Only `TerminalPanel` writes terminal content into xterm.
- Every emitted output chunk has a monotonic raw stream position.
- Hydration and live replay are phase-separated: live chunks buffer during hydration and only apply after the snapshot boundary is known.
- Chunks at or behind the session's known raw end are dropped before they can mutate attention state, working state, or terminal UI.
- Stale sessions cannot mutate the selected thread terminal.
- Exit is emitted only after reader completion and durable output sync.
- App-level unread/attention logic no longer treats replayed already-seen stream positions as fresh output.
- Follow state remains explicit in the terminal UI; manual scroll pause exposes `Jump to latest` instead of relying on repair heuristics.

## 3. Major deletions

Removed legacy merge and hydration paths that were compensating for conflicting terminal truths:

- `src/lib/terminalHydration.ts`
- `src/lib/terminalContentUpdate.ts`
- `tests/ui/terminal-hydration.test.ts`
- `tests/ui/terminal-content-update.test.ts`
- `mergeTerminalLogSnapshot`
- string-diff based hydration in `TerminalPanel`
- duplicate App-owned terminal log merge/reset helpers
- start-session reattach completion shim (`reattachCompletionAfterMs` / `reattachTurnCompletion`)

The remaining compatibility path in `TerminalPanel` is limited to static `content` callers used by tests and non-streamed mounts. The real app path is `streamState`-driven.

## 4. Remaining risks

- Local turn-completion semantics still depend on Claude JSONL shape when semantic completion events are needed. Output durability is protected even if the JSONL watcher stops recognizing completion entries, but completion labeling could regress.
- Some UI suites still emit React `act(...)` warnings. They are not failing, but they do indicate async test harness noise around state propagation.
- The production frontend bundle still triggers Vite's chunk-size warning; this is unrelated to terminal correctness.

## 5. Instructions for future maintainers

- Do not add a second terminal content source in `App.tsx`. If terminal output changes, change the stream reducer and keep `TerminalPanel` as the only xterm writer.
- Treat `startPosition` / `endPosition` as the source of truth for replay, dedupe, hydration boundaries, and unread suppression. Do not reintroduce text-diff heuristics.
- If you change hydration behavior, preserve this order: bind session -> buffer live chunks -> read snapshot -> replay only chunks beyond snapshot `endPosition`.
- If you change backend reader/exit behavior, preserve the guarantee that `terminal:exit` happens only after output sync and persisted `endPosition`.
- Validate changes with both automated and live checks:
  - `cargo test`
  - `yarn build`
  - `yarn test:ui`
  - real app scenarios: long stream, thread switching during output, resize during stream, scroll-up follow pause + resume, refresh-display repair, delayed bursts, and immediate exit after final output
- For live validation, a disposable `ATCONTROLLER_APP_SUPPORT_ROOT` plus a fake Claude CLI is the fastest way to stress the actual Tauri app without touching real user data.
