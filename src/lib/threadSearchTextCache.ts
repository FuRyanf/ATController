export const THREAD_SEARCH_TEXT_MAX_CHARS = 80_000;

function resolveMaxChars(maxChars: number): number {
  return Number.isFinite(maxChars) && maxChars > 0
    ? Math.trunc(maxChars)
    : THREAD_SEARCH_TEXT_MAX_CHARS;
}

export function trimThreadSearchText(
  text: string,
  maxChars = THREAD_SEARCH_TEXT_MAX_CHARS
): string {
  if (!text) {
    return '';
  }
  const limit = resolveMaxChars(maxChars);
  return text.length <= limit ? text : text.slice(text.length - limit);
}

export function rememberThreadSearchText(
  cache: Record<string, string>,
  threadId: string,
  text: string,
  maxChars = THREAD_SEARCH_TEXT_MAX_CHARS
): void {
  const searchableText = trimThreadSearchText(text, maxChars);
  if (!threadId || !searchableText) {
    delete cache[threadId];
    return;
  }
  cache[threadId] = searchableText;
}

export function clearThreadSearchText(cache: Record<string, string>, threadId: string): void {
  delete cache[threadId];
}
