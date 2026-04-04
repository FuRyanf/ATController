const TRUNCATED_PREFIX_SCAN_CHARS = 4096;
const CSI_FRAGMENT_REGEX = /^[0-9;?]+[ -/]*[@-~]/;

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

export function clampTerminalLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const roughStart = text.length - maxChars;
  const safeStart = alignStartToBoundary(text, roughStart);
  const clamped = text.slice(safeStart);
  return safeStart > 0 ? trimLeadingTruncatedControlSequence(clamped) : clamped;
}

