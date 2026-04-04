# Manual Terminal Rendering Checklist

1. Initial render correctness
- Open a workspace thread with existing output.
- Do not type anything.
- Expected: terminal paints the latest screen immediately (no stale/blank frame waiting for input).

2. Scroll stability (no meshing)
- Scroll up and down through large output.
- Expected: lines stay distinct, no overlaps, no merged glyph rows, no redraw corruption.

3. Streaming and cursor movement output
- Open a thread and run:
  `for i in $(seq 1 120); do printf "line %03d quick stream output\n" "$i"; sleep 0.02; done`
- Then run:
  `for i in $(seq 0 5 100); do printf "\rprogress %3d%%" "$i"; sleep 0.05; done; printf "\n"`
- Expected: delayed line streaming, wrapped lines, cursor-rewrite output, and progress updates render cleanly.

4. Large burst resilience
- Run:
  `for i in $(seq 1 200); do printf "burst %03d ........................................................................\n" "$i"; done`
- Expected: UI remains responsive and terminal repaints smoothly without freeze.

5. Resize correctness
- Resize app window repeatedly while output streams.
- Expected: terminal re-fits and wraps correctly; no resize loops; no clipped canvas.

6. Diagnostics
- Open browser dev tools console while streaming output.
- Expected: terminal output remains stable and no console errors appear during burst output and resize events.
