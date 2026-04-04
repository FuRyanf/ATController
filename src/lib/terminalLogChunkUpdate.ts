interface ResolveAppendedTerminalLogChunkParams {
  previousText: string;
  chunk: string;
  maxChars: number;
  present: (combined: string) => string;
}

interface AppendedTerminalLogChunkResult {
  nextText: string;
  requiresSnapshot: boolean;
}

export function resolveAppendedTerminalLogChunk({
  previousText,
  chunk,
  maxChars,
  present
}: ResolveAppendedTerminalLogChunkParams): AppendedTerminalLogChunkResult {
  const combined = `${previousText}${chunk}`;
  const nextText = present(combined);
  if (nextText === previousText) {
    return {
      nextText,
      requiresSnapshot: false
    };
  }

  if (nextText === combined) {
    return {
      nextText,
      requiresSnapshot: false
    };
  }

  const clamped =
    maxChars > 0 && combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
  return {
    nextText,
    requiresSnapshot: nextText !== clamped
  };
}
