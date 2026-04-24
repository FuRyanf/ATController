import { describe, expect, it } from 'vitest';

import {
  clearThreadSearchText,
  rememberThreadSearchText,
  trimThreadSearchText
} from '../../src/lib/threadSearchTextCache';

describe('thread search text cache', () => {
  it('keeps only the recent searchable tail', () => {
    expect(trimThreadSearchText('0123456789', 4)).toBe('6789');
  });

  it('stores bounded search text per thread', () => {
    const cache: Record<string, string> = {};

    rememberThreadSearchText(cache, 'thread-1', 'old output\nfresh result', 12);

    expect(cache['thread-1']).toBe('fresh result');
  });

  it('clears stale entries when a thread has no searchable text', () => {
    const cache: Record<string, string> = { 'thread-1': 'old output' };

    rememberThreadSearchText(cache, 'thread-1', '');

    expect(cache).toEqual({});
  });

  it('clears a single thread without touching other cached tails', () => {
    const cache: Record<string, string> = {
      'thread-1': 'one',
      'thread-2': 'two'
    };

    clearThreadSearchText(cache, 'thread-1');

    expect(cache).toEqual({ 'thread-2': 'two' });
  });
});
