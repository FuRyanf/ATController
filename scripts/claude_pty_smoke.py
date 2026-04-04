#!/usr/bin/env python3
"""Local PTY smoke test for Claude interactive terminal behavior.

Verifies that:
1) Claude starts in a PTY and emits interactive UI output.
2) Sending text + submit keystrokes triggers a run (inferring/interrupt state).
"""

from __future__ import annotations

import os
import pty
import re
import select
import shutil
import signal
import sys
import termios
import time
from typing import Tuple

ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
OSC_RE = re.compile(r"\x1B\].*?(?:\x07|\x1B\\)")


def strip_ansi(text: str) -> str:
    text = OSC_RE.sub("", text)
    text = ANSI_RE.sub("", text)
    return text


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", strip_ansi(text)).strip().lower()


def now() -> float:
    return time.monotonic()


def read_available(fd: int, timeout: float = 0.2) -> str:
    chunks: list[bytes] = []
    end = now() + timeout
    while now() < end:
        remaining = max(0.0, end - now())
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
    return b"".join(chunks).decode("utf-8", errors="replace")


def wait_for(fd: int, predicate, timeout: float, label: str, pid: int) -> Tuple[str, str]:
    raw = ""
    clean = ""
    deadline = now() + timeout
    while now() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            raise RuntimeError(f"Claude process exited early with status {status} while waiting for {label}")

        chunk = read_available(fd, 0.25)
        if chunk:
            raw += chunk
            clean += chunk
            if predicate(clean):
                return raw, strip_ansi(clean)
    raise RuntimeError(f"Timed out waiting for {label}")


def write_keys(fd: int, data: str) -> None:
    os.write(fd, data.encode("utf-8"))


def main() -> int:
    claude = os.environ.get("CLAUDE_CLI_PATH") or shutil.which("claude")
    if not claude:
        print("claude binary not found on PATH", file=sys.stderr)
        return 1

    pid, fd = pty.fork()
    if pid == 0:
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        os.execvpe(claude, [claude], env)
        return 127

    # Keep canonical mode off for reliable key forwarding semantics.
    attrs = termios.tcgetattr(fd)
    attrs[3] = attrs[3] & ~(termios.ICANON | termios.ECHO)
    termios.tcsetattr(fd, termios.TCSANOW, attrs)

    success = False
    collected_raw = ""
    collected_clean = ""

    try:
        raw, clean = wait_for(
            fd,
            lambda t: (
                len(normalize_text(t)) > 40
                or "claude" in normalize_text(t)
            ),
            timeout=20,
            label="initial Claude interactive output",
            pid=pid,
        )
        collected_raw += raw
        collected_clean += clean

        if "quick safety check" in normalize_text(collected_clean):
            write_keys(fd, "\r")
            raw, clean = wait_for(
                fd,
                lambda t: "for shortcuts" in normalize_text(t) or "claude" in normalize_text(t),
                timeout=20,
                label="post-trust prompt",
                pid=pid,
            )
            collected_raw += raw
            collected_clean += clean

        test_prompt = "integration-pty-smoke"
        write_keys(fd, test_prompt)
        # Emulate composer submit in app: Enter to end line, then blank-line submit.
        write_keys(fd, "\r")
        time.sleep(0.03)
        write_keys(fd, "\r")

        try:
            raw, clean = wait_for(
                fd,
                lambda t: (
                    "esc to interrupt" in normalize_text(t)
                    or "inferring" in normalize_text(t)
                    or "whatchamacalliting" in normalize_text(t)
                    or "moseying" in normalize_text(t)
                    or "frosting" in normalize_text(t)
                    or "dilly-dallying" in normalize_text(t)
                    or "press ctrl-c again to exit" in normalize_text(t)
                    or normalize_text(t).count("❯") >= 2
                ),
                timeout=25,
                label="run state after submitting prompt",
                pid=pid,
            )
        except RuntimeError:
            # Some prompt states need one more Enter to trigger send.
            write_keys(fd, "\r")
            raw, clean = wait_for(
                fd,
                lambda t: (
                    "esc to interrupt" in normalize_text(t)
                    or "inferring" in normalize_text(t)
                    or "whatchamacalliting" in normalize_text(t)
                    or "moseying" in normalize_text(t)
                    or "frosting" in normalize_text(t)
                    or "dilly-dallying" in normalize_text(t)
                    or "press ctrl-c again to exit" in normalize_text(t)
                    or normalize_text(t).count("❯") >= 2
                ),
                timeout=25,
                label="run state after fallback submit",
                pid=pid,
            )
        collected_raw += raw
        collected_clean += clean

        # Interrupt and close.
        os.kill(pid, signal.SIGINT)
        time.sleep(0.2)
        os.kill(pid, signal.SIGINT)
        success = True
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

        tail = "\n".join(collected_clean.splitlines()[-60:])
        print("\n=== Claude PTY smoke tail ===")
        print(tail)

    if not success:
        return 1

    print("\nClaude PTY smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
