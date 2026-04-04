import { describe, expect, it, vi } from 'vitest';

import { TerminalWriteQueue } from '../../src/lib/terminalWriteQueue';

describe('TerminalWriteQueue', () => {
  it('buffers output before sink is attached, then flushes in order', async () => {
    vi.useFakeTimers();
    const queue = new TerminalWriteQueue({
      maxBatchBytes: 4,
      scheduleFlush: (flush) => window.setTimeout(flush, 0),
      cancelFlush: (id) => window.clearTimeout(id)
    });

    queue.enqueue('AB');
    queue.enqueue('CD');
    queue.enqueue('EF');

    const writes: string[] = [];
    queue.setSink({
      write: (chunk, done) => {
        writes.push(chunk);
        done();
      }
    });

    vi.runAllTimers();
    await Promise.resolve();

    expect(writes.join('')).toBe('ABCDEF');
    expect(writes).toEqual(['ABCD', 'EF']);
    vi.useRealTimers();
  });

  it('preserves FIFO ordering across async writes', async () => {
    vi.useFakeTimers();
    const queue = new TerminalWriteQueue({
      maxBatchBytes: 2,
      maxFlushDelayMs: 48,
      scheduleFlush: (flush) => window.setTimeout(flush, 0),
      cancelFlush: (id) => window.clearTimeout(id)
    });

    const writes: string[] = [];
    queue.setSink({
      write: (chunk, done) => {
        writes.push(chunk);
        window.setTimeout(done, 5);
      }
    });

    queue.enqueue('aa');
    queue.enqueue('bb');
    queue.enqueue('cc');

    vi.runAllTimers();
    await Promise.resolve();
    expect(writes).toEqual(['aa', 'bb', 'cc']);
    vi.useRealTimers();
  });

  it('forces a flush when scheduled frame flush is delayed beyond max latency', async () => {
    vi.useFakeTimers();
    const queue = new TerminalWriteQueue({
      maxBatchBytes: 8,
      maxFlushDelayMs: 20,
      scheduleFlush: (flush) => window.setTimeout(flush, 1_000),
      cancelFlush: (id) => window.clearTimeout(id),
      scheduleTimer: (flush, delayMs) => window.setTimeout(flush, delayMs),
      cancelTimer: (id) => window.clearTimeout(id)
    });

    const writes: string[] = [];
    queue.setSink({
      write: (chunk, done) => {
        writes.push(chunk);
        done();
      }
    });

    queue.enqueue('burst');
    vi.advanceTimersByTime(19);
    await Promise.resolve();
    expect(writes).toEqual([]);

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(writes).toEqual(['burst']);
    expect(queue.getStats().maxQueueLatencyMs).toBeGreaterThanOrEqual(20);
    vi.useRealTimers();
  });

  it('supports dynamic batch-size changes without reordering output', async () => {
    vi.useFakeTimers();
    const queue = new TerminalWriteQueue({
      maxBatchBytes: 8,
      scheduleFlush: (flush) => window.setTimeout(flush, 0),
      cancelFlush: (id) => window.clearTimeout(id)
    });

    const writes: string[] = [];
    queue.setSink({
      write: (chunk, done) => {
        writes.push(chunk);
        done();
      }
    });

    queue.enqueue('AAA');
    queue.enqueue('BBB');
    queue.enqueue('CCC');
    queue.setMaxBatchBytes(4);

    vi.runAllTimers();
    await Promise.resolve();

    expect(writes).toEqual(['AAA', 'BBB', 'CCC']);
    expect(writes.join('')).toBe('AAABBBCCC');
    vi.useRealTimers();
  });

  it('resolves whenIdle after queued async writes complete', async () => {
    vi.useFakeTimers();
    const queue = new TerminalWriteQueue({
      maxBatchBytes: 16,
      scheduleFlush: (flush) => window.setTimeout(flush, 0),
      cancelFlush: (id) => window.clearTimeout(id)
    });

    const writes: string[] = [];
    queue.setSink({
      write: (chunk, done) => {
        writes.push(chunk);
        window.setTimeout(done, 10);
      }
    });

    queue.enqueue('A');
    queue.enqueue('B');
    const idlePromise = queue.whenIdle();

    vi.advanceTimersByTime(9);
    await Promise.resolve();
    expect(writes).toEqual(['AB']);

    let settled = false;
    void idlePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
