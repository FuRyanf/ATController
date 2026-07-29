const ANSI_REGEX =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*(?:\u001b\\)?|[@-_])/gu;

const ALT_SCREEN_ENTER_REGEX = /\u001b\[\?(?:1049|1047)h/u;
const CURSOR_POSITION_REGEX = /\u001b\[\d{1,4};\d{1,4}[Hf]/gu;
const CLEAR_OR_ERASE_REGEX = /\u001b\[(?:2J|J|K|0K|2K)/gu;
const CURSOR_HIDE_REGEX = /\u001b\[\?25l/gu;
const CODEX_UI_TEXT_REGEX =
  /(OpenAI\s*Codex|\bCodex\b|esc\s*to\s*interrupt|tokens?\s*left|context\s*left|Working|Running)/iu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function looksLikeStatefulTerminalUi(text: string): boolean {
  if (!text) {
    return false;
  }

  if (ALT_SCREEN_ENTER_REGEX.test(text)) {
    return true;
  }

  const plainText = stripAnsi(text);
  if (!CODEX_UI_TEXT_REGEX.test(plainText)) {
    return false;
  }

  let controlSignalCount = 0;
  const cursorPositions = text.match(CURSOR_POSITION_REGEX)?.length ?? 0;
  const clears = text.match(CLEAR_OR_ERASE_REGEX)?.length ?? 0;
  const hiddenCursor = text.match(CURSOR_HIDE_REGEX)?.length ?? 0;

  if (cursorPositions > 0) {
    controlSignalCount += 1;
  }
  if (clears > 0) {
    controlSignalCount += 1;
  }
  if (hiddenCursor > 0) {
    controlSignalCount += 1;
  }

  return controlSignalCount >= 2 || cursorPositions >= 3 || (clears > 0 && CODEX_UI_TEXT_REGEX.test(plainText));
}
