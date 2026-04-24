import { describe, expect, it } from 'vitest';

import {
  appendMeaningfulOutputTail,
  extractMeaningfulOutputTail,
  matchesVisibleOutputTail,
  normalizeMeaningfulOutputText
} from '../../src/lib/visibleOutputTail';

describe('visible output tail', () => {
  it('extracts a compact meaningful tail without a trailing shell prompt', () => {
    const tail = extractMeaningfulOutputTail('build started\nbuild complete\nproject$ ');

    expect(tail).toBe('build started build complete');
  });

  it('appends normalized live chunks without rescanning full scrollback', () => {
    const first = appendMeaningfulOutputTail('', normalizeMeaningfulOutputText('alpha\nbeta'), 20);
    const second = appendMeaningfulOutputTail(first, normalizeMeaningfulOutputText('gamma delta'), 20);

    expect(second).toBe('pha beta gamma delta');
  });

  it('ignores prompt-only chunks when extending a visible tail', () => {
    expect(appendMeaningfulOutputTail('previous result', 'project$ ')).toBe('previous result');
  });

  it('matches replay chunks against the remembered visible tail', () => {
    expect(matchesVisibleOutputTail('fresh result', 'old output fresh result')).toBe(true);
    expect(matchesVisibleOutputTail('different result', 'old output fresh result')).toBe(false);
  });
});
