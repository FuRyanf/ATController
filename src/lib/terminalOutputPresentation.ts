import { clampTerminalWindow, extractLatestTerminalScreenWindow } from './terminalLogClamp';
import { looksLikeStatefulTerminalUi } from './terminalUiHeuristics';

interface PresentTerminalTextOptions {
  currentText?: string | null;
  maxChars: number;
  stripHiddenPrompts?: ((text: string) => string) | null;
}

interface PresentTerminalEventOptions {
  currentText?: string | null;
  stripHiddenPrompts?: ((text: string) => string) | null;
}

interface TerminalPresentationWindow {
  text: string;
  startOffset: number;
  preserveRaw: boolean;
}

export function shouldPreserveRawTerminalPresentation(
  nextText: string | null | undefined,
  currentText: string | null | undefined = null
): boolean {
  return Boolean(
    (nextText && looksLikeStatefulTerminalUi(nextText)) ||
      (currentText && looksLikeStatefulTerminalUi(currentText))
  );
}

export function presentTerminalText(
  rawText: string,
  options: PresentTerminalTextOptions
): string {
  return presentTerminalWindow(rawText, options).text;
}

export function presentTerminalWindow(
  rawText: string,
  options: PresentTerminalTextOptions
): TerminalPresentationWindow {
  const preserveRaw = shouldPreserveRawTerminalPresentation(rawText, options.currentText);
  const visibleText =
    preserveRaw || !options.stripHiddenPrompts ? rawText : options.stripHiddenPrompts(rawText);
  const clamped =
    preserveRaw && looksLikeStatefulTerminalUi(visibleText)
      ? extractLatestTerminalScreenWindow(visibleText, options.maxChars)
      : clampTerminalWindow(visibleText, options.maxChars);
  return {
    text: clamped.text,
    startOffset: clamped.startOffset,
    preserveRaw
  };
}

export function presentTerminalEventData(
  rawData: string,
  options: PresentTerminalEventOptions
): string {
  if (shouldPreserveRawTerminalPresentation(rawData, options.currentText)) {
    return rawData;
  }
  return options.stripHiddenPrompts ? options.stripHiddenPrompts(rawData) : rawData;
}
