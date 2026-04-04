# Known Issues

## CLI Status Bar Rendering Drift (Terminal Corruption)

### Symptom

During long-running Claude sessions with sparse terminal output (builds waiting
on I/O, long tool executions), the CLI's status bar text ("Wrangling...",
progress indicators, token counts) gradually bleeds into content lines. This
produces jumbled or misplaced characters, typically visible in the top-left
area of the terminal. Manual window resize fixes it instantly, but the
corruption returns over time.

### Root Cause

The Claude CLI draws its status bar using **relative ANSI cursor moves**:

- `\r` (carriage return) to go to column 0
- `\e[1B` (CUD1) to move down one row
- `\e[1C` (CUF1) to move forward one column (used as spacing)

The CLI does **not** use absolute cursor positioning (`\e[row;colH`) or
cursor save/restore (`\e[s` / `\e[u`).

The drift is caused by **unicode/emoji character width disagreements** between
the CLI's `wcwidth` implementation and xterm.js. When the CLI renders a
character like `*` (U+2733 eight-spoked asterisk), it calculates the display
width as N cells, but xterm.js may render it as M cells (where M != N). The
`\e[1C` spacing after the character then positions the cursor at the wrong
column.

Each status bar redraw (every few seconds during active sessions) accumulates
a small positional error. Over ~5 minutes of sparse output, the error becomes
visually apparent.

### Evidence

Analysis of a 2.7MB output.log from a Claude session showed:

| Sequence | Count | Purpose |
|----------|-------|---------|
| `\r` (CR) | 118,680 | Status bar line redraws |
| `\n` (LF) | 79,843 | Content line breaks |
| `\e[1C` (CUF1) | 78,475 | Spacing in status bar (the drift source) |
| `\e[1B` (CUD1) | 75 | Status bar line transitions |
| Cursor save/restore | 0 | Not used by the CLI |

The high count of `\e[1C` relative to content lines confirms the CLI uses
CUF1 extensively for status bar layout. Each CUF1 near a wide character
introduces a sub-cell positioning error.

### Why Manual Resize Fixes It

When the user resizes the window:

1. Container pixel dimensions change
2. `FitAddon.fit()` calculates genuinely different cols/rows
3. The PTY is resized to the new dimensions
4. The OS kernel sends **SIGWINCH** to the CLI process
5. The CLI receives SIGWINCH and **redraws its entire status bar from scratch**
6. All cursor positions are recalculated relative to the new dimensions
7. The accumulated drift is reset to zero

### Why `fitWithReflow` Doesn't Fix It

The stream repair mechanism calls `fitWithReflow`, which does:

```
term.resize(cols + 1, rows)  // xterm.js only
term.resize(cols, rows)       // xterm.js only
fitAddon.fit()                // short-circuits (same pixel container)
```

This forces xterm.js to reflow its internal line buffer, but it **never
notifies the PTY** of a size change. The PTY stays at the same cols/rows,
so the OS never sends SIGWINCH to the CLI. The CLI never redraws.

### Current Fix

**SIGWINCH on thread selection** (commit `9192d38`):

When the user switches to a Claude thread, the app sends two PTY resize
commands before the terminal content loads:

```typescript
void api.terminalResize(sessionId, cols + 1, rows);  // SIGWINCH #1
void api.terminalResize(sessionId, cols, rows);       // SIGWINCH #2
```

This triggers SIGWINCH, forcing the CLI to redraw. The redraw happens during
the natural React remount of the TerminalPanel (caused by the `key` change
on thread selection), so it's invisible to the user.

**Tradeoffs:**
- The fix only applies when switching threads. If a user stays on one thread
  for 30+ minutes, they may see drift. However, any thread switch (even
  clicking away and back) clears it instantly.
- Two extra PTY resize IPC calls per thread switch (~microseconds, negligible).
- Workspace shells also receive the SIGWINCH, but shells handle it gracefully.

### What Would Truly Fix It

The root cause is a `wcwidth` disagreement between the CLI and xterm.js. A
true fix would require one of:

1. **CLI change:** Use absolute cursor positioning (`\e[row;colH`) instead of
   relative moves, or use spaces instead of `\e[1C` for status bar spacing.
2. **CLI change:** Align the CLI's `wcwidth` with xterm.js's unicode width
   tables.
3. **Terminal-side workaround:** Intercept and rewrite the CLI's ANSI output
   to correct cursor positions based on xterm.js's actual character widths.
   This is invasive and fragile.

Option 1 or 2 would eliminate the drift entirely. The current SIGWINCH
workaround is the pragmatic containment strategy until the CLI is updated.

### Related Commits

- `9192d38` - Fix CLI status bar rendering drift via SIGWINCH on thread selection
- `761f464` - Add idle reflow to fix rendering drift during sparse terminal output
- `a6ab69a` - Fix terminal flash/scroll-to-top on large output and trim boundaries
