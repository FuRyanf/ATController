const TRUNCATED_PREFIX_SCAN_CHARS = 4096;
const CSI_FRAGMENT_REGEX = /^[0-9;?]+[ -/]*[@-~]/;
const REPAINT_FRAME_LOOKBACK_MULTIPLIER = 1;
const TERMINAL_REPAINT_BOUNDARIES = [
  '\u001b[2J\u001b[H',
  '\u001b[H\u001b[2J',
  '\u001b[3J\u001b[H',
  '\u001b[?1049h',
  '\u001bc',
  '\u001b[2J',
  '\u001b[3J'
] as const;
const TERMINAL_LINE_REPAINT_BOUNDARIES = [
  '\r\u001b[2K',
  '\r\u001b[K',
  '\r\u001b[0K',
  '\u001b[2K\r',
  '\u001b[K\r',
  '\u001b[0K\r',
  '\u001b[1G\u001b[2K',
  '\u001b[1G\u001b[K',
  '\u001b[1G\u001b[0K'
] as const;
const ALT_SCREEN_ENTERS = ['\u001b[?1049h', '\u001b[?1047h'] as const;
const ALT_SCREEN_EXITS = ['\u001b[?1049l', '\u001b[?1047l'] as const;

function alignStartToBoundary(text: string, start: number): number {
  if (start <= 0) {
    return 0;
  }

  const previous = text[start - 1];
  if (previous === '\n' || previous === '\r') {
    return start;
  }

  const scanEnd = Math.min(text.length, start + TRUNCATED_PREFIX_SCAN_CHARS);
  for (let index = start; index < scanEnd; index += 1) {
    const char = text[index];
    if (char === '\n' || char === '\r') {
      return index + 1;
    }
  }

  return start;
}

function trimLeadingTruncatedControlSequence(text: string): string {
  let next = text;

  // Drop orphan OSC payload if truncation removed the leading ESC.
  if (next.startsWith(']')) {
    const belIndex = next.indexOf('\u0007');
    const stIndex = next.indexOf('\u001b\\');
    const oscEnd = Math.min(
      belIndex === -1 ? Number.POSITIVE_INFINITY : belIndex + 1,
      stIndex === -1 ? Number.POSITIVE_INFINITY : stIndex + 2
    );
    if (Number.isFinite(oscEnd)) {
      next = next.slice(oscEnd);
    }
  }

  // Drop orphan CSI payload if truncation removed the leading ESC.
  if (next.startsWith('[')) {
    const match = next.slice(1).match(CSI_FRAGMENT_REGEX);
    if (match) {
      next = next.slice(1 + match[0].length);
    }
  }

  return next;
}

function findLastTerminalRepaintBoundary(text: string, start: number): number {
  let lastBoundary = -1;
  for (const marker of TERMINAL_REPAINT_BOUNDARIES) {
    const idx = text.lastIndexOf(marker, text.length - 1);
    if (idx >= start && idx > lastBoundary) {
      lastBoundary = idx;
    }
  }
  return lastBoundary;
}

function findIntersectingTerminalRepaintBoundary(text: string, start: number): number {
  let intersectingBoundary = -1;
  for (const marker of TERMINAL_REPAINT_BOUNDARIES) {
    const idx = text.lastIndexOf(marker, start);
    if (idx === -1) {
      continue;
    }
    if (idx < start && idx + marker.length > start && idx > intersectingBoundary) {
      intersectingBoundary = idx;
    }
  }
  return intersectingBoundary;
}

function findLatestBoundary(text: string, boundaries: readonly string[]): number {
  let latestBoundary = -1;
  for (const marker of boundaries) {
    const index = text.lastIndexOf(marker);
    if (index > latestBoundary) {
      latestBoundary = index;
    }
  }
  return latestBoundary;
}

function terminalRepaintBoundaryLengthAt(text: string, index: number): number {
  let boundaryLength = 0;
  for (const marker of TERMINAL_REPAINT_BOUNDARIES) {
    if (text.startsWith(marker, index) && marker.length > boundaryLength) {
      boundaryLength = marker.length;
    }
  }
  return boundaryLength;
}

function activeAlternateScreenPreamble(text: string, beforeIndex: number): string {
  let latestEnterIndex = -1;
  let latestEnter = '';
  for (const marker of ALT_SCREEN_ENTERS) {
    const index = text.lastIndexOf(marker, Math.max(0, beforeIndex - 1));
    if (index > latestEnterIndex) {
      latestEnterIndex = index;
      latestEnter = marker;
    }
  }

  let latestExitIndex = -1;
  for (const marker of ALT_SCREEN_EXITS) {
    latestExitIndex = Math.max(
      latestExitIndex,
      text.lastIndexOf(marker, Math.max(0, beforeIndex - 1))
    );
  }
  return latestEnterIndex > latestExitIndex ? latestEnter : '';
}

export function findLatestTerminalRepaintBoundary(text: string): number {
  return findLastTerminalRepaintBoundary(text, 0);
}

/**
 * Removes terminal output that is guaranteed to have been superseded by a
 * later fullscreen or current-line repaint. This is intended for replaying a
 * stored terminal stream into a fresh emulator; ordinary output and bare
 * carriage returns are left untouched.
 */
export function coalesceTerminalRedrawFrames(text: string): string {
  if (!text) {
    return text;
  }

  const repaintBoundary = findLatestTerminalRepaintBoundary(text);
  const replayStart = Math.max(0, repaintBoundary);
  let replay = text.slice(replayStart);
  const requiredPrefixLength =
    repaintBoundary === -1 ? 0 : terminalRepaintBoundaryLengthAt(text, repaintBoundary);

  const lineRepaintBoundary = findLatestBoundary(replay, TERMINAL_LINE_REPAINT_BOUNDARIES);
  if (lineRepaintBoundary > requiredPrefixLength) {
    const latestLineBreak = replay.lastIndexOf('\n', lineRepaintBoundary);
    const prefixEnd = Math.max(requiredPrefixLength, latestLineBreak + 1);
    replay = `${replay.slice(0, prefixEnd)}${replay.slice(lineRepaintBoundary)}`;
  }

  if (replayStart === 0) {
    return replay;
  }

  const alternateScreenPreamble = activeAlternateScreenPreamble(text, replayStart);
  if (!alternateScreenPreamble || replay.startsWith(alternateScreenPreamble)) {
    return replay;
  }
  return `${alternateScreenPreamble}${replay}`;
}

export function findSafeTerminalLogStart(text: string, maxChars: number): number {
  if (text.length <= maxChars) {
    return 0;
  }

  const roughStart = text.length - maxChars;
  const repaintBoundary = findLastTerminalRepaintBoundary(text, roughStart);
  if (repaintBoundary >= roughStart) {
    return repaintBoundary;
  }
  const latestRepaintBoundary = findLastTerminalRepaintBoundary(text, 0);
  if (
    latestRepaintBoundary !== -1 &&
    latestRepaintBoundary < roughStart &&
    roughStart - latestRepaintBoundary <= maxChars * REPAINT_FRAME_LOOKBACK_MULTIPLIER
  ) {
    return latestRepaintBoundary;
  }
  const intersectingRepaintBoundary = findIntersectingTerminalRepaintBoundary(text, roughStart);
  if (intersectingRepaintBoundary !== -1) {
    return intersectingRepaintBoundary;
  }

  return alignStartToBoundary(text, roughStart);
}

export function clampTerminalWindow(
  text: string,
  maxChars: number
): { text: string; startOffset: number } {
  if (text.length <= maxChars) {
    return {
      text,
      startOffset: 0
    };
  }

  const safeStart = findSafeTerminalLogStart(text, maxChars);
  const clamped = text.slice(safeStart);
  if (safeStart <= 0) {
    return {
      text: clamped,
      startOffset: safeStart
    };
  }

  const trimmed = trimLeadingTruncatedControlSequence(clamped);
  return {
    text: trimmed,
    startOffset: safeStart + (clamped.length - trimmed.length)
  };
}

export function extractLatestTerminalScreenWindow(
  text: string,
  maxChars: number
): { text: string; startOffset: number } {
  const latestBoundary = findLatestTerminalRepaintBoundary(text);
  if (latestBoundary === -1) {
    return clampTerminalWindow(text, maxChars);
  }

  const latestFrame = text.slice(latestBoundary);
  if (maxChars <= 0 || latestFrame.length <= maxChars) {
    return {
      text: latestFrame,
      startOffset: latestBoundary
    };
  }

  const clamped = clampTerminalWindow(latestFrame, maxChars);
  return {
    text: clamped.text,
    startOffset: latestBoundary + clamped.startOffset
  };
}

export function clampTerminalLog(text: string, maxChars: number): string {
  return clampTerminalWindow(text, maxChars).text;
}
