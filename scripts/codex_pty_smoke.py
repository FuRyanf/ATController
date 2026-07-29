#!/usr/bin/env python3
"""No-auth PTY contract smoke test for the local OpenAI Codex CLI."""

from __future__ import annotations

import os
import pty
import re
import select
import shutil
import sys
import time

ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
OSC_RE = re.compile(r"\x1B\].*?(?:\x07|\x1B\\)")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", OSC_RE.sub("", text))


def run_in_pty(executable: str, *args: str, timeout: float = 15.0) -> str:
    pid, fd = pty.fork()
    if pid == 0:
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        os.execvpe(executable, [executable, *args], env)
        return ""

    output = bytearray()
    deadline = time.monotonic() + timeout
    status: int | None = None
    reached_eof = False
    while time.monotonic() < deadline:
        if status is None:
            finished, candidate_status = os.waitpid(pid, os.WNOHANG)
            if finished:
                status = candidate_status
        ready, _, _ = select.select([] if reached_eof else [fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                output.extend(chunk)
            else:
                reached_eof = True
        if status is not None and reached_eof:
            break

    if status is None:
        os.kill(pid, 15)
        os.waitpid(pid, 0)
        raise RuntimeError(f"Codex command timed out: {' '.join(args)}")
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError(
            f"Codex command failed ({os.waitstatus_to_exitcode(status)}): {' '.join(args)}"
        )
    return strip_ansi(output.decode("utf-8", errors="replace"))


def main() -> int:
    executable = os.environ.get("CODEX_CLI_PATH") or shutil.which("codex")
    if not executable:
        print("Codex CLI not found on PATH", file=sys.stderr)
        return 1

    version = run_in_pty(executable, "--version")
    help_text = run_in_pty(executable, "--help")
    required_tokens = (
        "resume",
        "fork",
        "--sandbox",
        "--ask-for-approval",
        "--dangerously-bypass-approvals-and-sandbox",
    )
    missing = [token for token in required_tokens if token not in help_text]
    if missing:
        print(f"Codex CLI help is missing required interface tokens: {', '.join(missing)}", file=sys.stderr)
        return 1

    print(version.strip())
    print("Codex PTY contract smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
