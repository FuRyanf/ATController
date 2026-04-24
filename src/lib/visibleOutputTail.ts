import { stripAnsi } from './terminalUiHeuristics';

export const MAX_VISIBLE_OUTPUT_TAIL_CHARS = 512;

export function normalizeMeaningfulOutputText(chunk: string): string {
  if (!chunk) {
    return '';
  }
  return stripAnsi(chunk)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeShellPromptText(chunk: string): boolean {
  if (!chunk) {
    return false;
  }

  const lines = stripAnsi(chunk)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0 || lines.length > 2) {
    return false;
  }

  const line = lines[lines.length - 1];
  if (!/[#$%>]$/.test(line)) {
    return false;
  }

  const withoutPrompt = line.slice(0, -1).trim();
  if (!withoutPrompt) {
    return true;
  }

  if (/[.?!]$/.test(withoutPrompt)) {
    return false;
  }

  const tokens = withoutPrompt.split(/\s+/);
  if (tokens.length > 4) {
    return false;
  }

  const hasShellLikeToken = tokens.some((token) => /[@/~:[\]()\\]/.test(token));
  if (!hasShellLikeToken && tokens.length !== 1) {
    return false;
  }

  return tokens.every((token) => {
    if (/^\[[^\]]+\]$/.test(token) || /^\([^)]+\)$/.test(token)) {
      return true;
    }
    return /^[A-Za-z0-9._/+:-]+$/.test(token);
  });
}

export function trimMeaningfulOutputTail(
  text: string,
  maxChars = MAX_VISIBLE_OUTPUT_TAIL_CHARS
): string {
  const tail = text.trim();
  if (!tail) {
    return '';
  }
  return tail.length <= maxChars ? tail : tail.slice(tail.length - maxChars);
}

export function extractMeaningfulOutputTail(
  text: string,
  maxChars = MAX_VISIBLE_OUTPUT_TAIL_CHARS
): string {
  if (!text) {
    return '';
  }

  const lines = stripAnsi(text)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim())
    .filter((line) => line.length > 0);

  while (lines.length > 0 && looksLikeShellPromptText(lines[lines.length - 1] ?? '')) {
    lines.pop();
  }

  if (lines.length === 0) {
    return '';
  }

  return trimMeaningfulOutputTail(normalizeMeaningfulOutputText(lines.join('\n')), maxChars);
}

export function appendMeaningfulOutputTail(
  currentTail: string,
  normalizedChunk: string,
  maxChars = MAX_VISIBLE_OUTPUT_TAIL_CHARS
): string {
  const previousTail = trimMeaningfulOutputTail(currentTail, maxChars);
  const nextTail = normalizeMeaningfulOutputText(normalizedChunk);
  if (!nextTail || looksLikeShellPromptText(nextTail)) {
    return previousTail;
  }
  return trimMeaningfulOutputTail(previousTail ? `${previousTail} ${nextTail}` : nextTail, maxChars);
}

export function matchesVisibleOutputTail(normalizedChunk: string, visibleTail: string): boolean {
  if (!normalizedChunk || !visibleTail) {
    return false;
  }
  return (
    visibleTail === normalizedChunk ||
    visibleTail.includes(normalizedChunk) ||
    visibleTail.endsWith(normalizedChunk) ||
    normalizedChunk.includes(visibleTail) ||
    normalizedChunk.endsWith(visibleTail)
  );
}
