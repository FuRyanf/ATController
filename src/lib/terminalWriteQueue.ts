type WriteSink = {
  write: (chunk: string, done: () => void) => void;
};

type ScheduleFlush = (flush: () => void) => number;
type CancelFlush = (id: number) => void;

interface TerminalWriteQueueOptions {
  maxBatchBytes?: number;
  maxFlushDelayMs?: number;
  scheduleFlush?: ScheduleFlush;
  cancelFlush?: CancelFlush;
  scheduleTimer?: (flush: () => void, delayMs: number) => number;
  cancelTimer?: (id: number) => void;
}

export interface TerminalWriteQueueStats {
  pendingChunks: number;
  pendingBytes: number;
  highWaterBytes: number;
  highWaterChunks: number;
  totalWrites: number;
  totalBytesWritten: number;
  writing: boolean;
  lastQueueLatencyMs: number;
  maxQueueLatencyMs: number;
  maxFlushDelayMs: number;
}

const DEFAULT_MAX_BATCH_BYTES = 16 * 1024;
const DEFAULT_MAX_FLUSH_DELAY_MS = 48;

function defaultScheduleFlush(flush: () => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(() => flush());
  }
  return globalThis.setTimeout(() => flush(), 8) as unknown as number;
}

function defaultCancelFlush(id: number) {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id);
    return;
  }
  globalThis.clearTimeout(id);
}

function defaultScheduleTimer(flush: () => void, delayMs: number): number {
  return globalThis.setTimeout(flush, delayMs) as unknown as number;
}

function defaultCancelTimer(id: number) {
  globalThis.clearTimeout(id);
}

interface PendingChunk {
  chunk: string;
  enqueuedAtMs: number;
}

export class TerminalWriteQueue {
  private maxBatchBytes: number;

  private readonly maxFlushDelayMs: number;

  private readonly scheduleFlush: ScheduleFlush;

  private readonly cancelFlush: CancelFlush;

  private readonly scheduleTimer: (flush: () => void, delayMs: number) => number;

  private readonly cancelTimer: (id: number) => void;

  private sink: WriteSink | null = null;

  private pendingChunks: PendingChunk[] = [];

  private pendingBytes = 0;

  private highWaterBytes = 0;

  private highWaterChunks = 0;

  private totalWrites = 0;

  private totalBytesWritten = 0;

  private writing = false;

  private lastQueueLatencyMs = 0;

  private maxQueueLatencyMs = 0;

  private scheduledFlushId: number | null = null;

  private delayedFlushGuardId: number | null = null;

  private epoch = 0;

  private idleResolvers: Array<() => void> = [];

  constructor(options: TerminalWriteQueueOptions = {}) {
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxFlushDelayMs = options.maxFlushDelayMs ?? DEFAULT_MAX_FLUSH_DELAY_MS;
    this.scheduleFlush = options.scheduleFlush ?? defaultScheduleFlush;
    this.cancelFlush = options.cancelFlush ?? defaultCancelFlush;
    this.scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
    this.cancelTimer = options.cancelTimer ?? defaultCancelTimer;
  }

  setSink(sink: WriteSink | null) {
    this.sink = sink;
    if (sink) {
      this.scheduleDrain();
      this.scheduleDelayedFlushGuard();
    }
  }

  setMaxBatchBytes(maxBatchBytes: number) {
    if (!Number.isFinite(maxBatchBytes) || maxBatchBytes <= 0) {
      return;
    }
    this.maxBatchBytes = Math.floor(maxBatchBytes);
  }

  enqueue(chunk: string) {
    if (!chunk) {
      return;
    }

    const nowMs = Date.now();
    this.pendingChunks.push({
      chunk,
      enqueuedAtMs: nowMs
    });
    this.pendingBytes += chunk.length;
    if (this.pendingBytes > this.highWaterBytes) {
      this.highWaterBytes = this.pendingBytes;
    }
    if (this.pendingChunks.length > this.highWaterChunks) {
      this.highWaterChunks = this.pendingChunks.length;
    }
    this.scheduleDrain();
    this.scheduleDelayedFlushGuard();
  }

  clear() {
    this.epoch += 1;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.writing = false;
    if (this.scheduledFlushId !== null) {
      this.cancelFlush(this.scheduledFlushId);
      this.scheduledFlushId = null;
    }
    if (this.delayedFlushGuardId !== null) {
      this.cancelTimer(this.delayedFlushGuardId);
      this.delayedFlushGuardId = null;
    }
    this.resolveIdleWaiters();
  }

  flushImmediate() {
    if (this.scheduledFlushId !== null) {
      this.cancelFlush(this.scheduledFlushId);
      this.scheduledFlushId = null;
    }
    if (this.delayedFlushGuardId !== null) {
      this.cancelTimer(this.delayedFlushGuardId);
      this.delayedFlushGuardId = null;
    }
    this.drain();
  }

  whenIdle(): Promise<void> {
    if (!this.writing && this.pendingChunks.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  getStats(): TerminalWriteQueueStats {
    return {
      pendingChunks: this.pendingChunks.length,
      pendingBytes: this.pendingBytes,
      highWaterBytes: this.highWaterBytes,
      highWaterChunks: this.highWaterChunks,
      totalWrites: this.totalWrites,
      totalBytesWritten: this.totalBytesWritten,
      writing: this.writing,
      lastQueueLatencyMs: this.lastQueueLatencyMs,
      maxQueueLatencyMs: this.maxQueueLatencyMs,
      maxFlushDelayMs: this.maxFlushDelayMs
    };
  }

  private scheduleDrain() {
    if (this.scheduledFlushId !== null) {
      return;
    }
    this.scheduledFlushId = this.scheduleFlush(() => {
      this.scheduledFlushId = null;
      this.drain();
    });
  }

  private scheduleDelayedFlushGuard() {
    if (this.maxFlushDelayMs <= 0) {
      return;
    }
    if (this.delayedFlushGuardId !== null) {
      return;
    }
    this.delayedFlushGuardId = this.scheduleTimer(() => {
      this.delayedFlushGuardId = null;
      if (this.pendingChunks.length === 0) {
        return;
      }
      if (this.writing) {
        this.scheduleDelayedFlushGuard();
        return;
      }
      this.flushImmediate();
    }, this.maxFlushDelayMs);
  }

  private drain() {
    if (this.writing) {
      return;
    }
    if (!this.sink) {
      return;
    }
    if (this.pendingChunks.length === 0) {
      this.resolveIdleWaiters();
      return;
    }

    const queueLatencyMs = Math.max(0, Date.now() - this.pendingChunks[0].enqueuedAtMs);
    this.lastQueueLatencyMs = queueLatencyMs;
    if (queueLatencyMs > this.maxQueueLatencyMs) {
      this.maxQueueLatencyMs = queueLatencyMs;
    }

    const batch = this.takeBatch();
    if (!batch) {
      return;
    }

    this.writing = true;
    this.totalWrites += 1;
    this.totalBytesWritten += batch.length;
    const writeEpoch = this.epoch;
    this.sink.write(batch, () => {
      if (writeEpoch !== this.epoch) {
        return;
      }
      this.writing = false;
      if (this.pendingChunks.length > 0) {
        this.scheduleDrain();
        this.scheduleDelayedFlushGuard();
        return;
      }
      this.resolveIdleWaiters();
    });
  }

  private resolveIdleWaiters() {
    if (this.writing || this.pendingChunks.length > 0) {
      return;
    }
    if (this.idleResolvers.length === 0) {
      return;
    }
    const resolvers = this.idleResolvers.splice(0, this.idleResolvers.length);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private takeBatch(): string {
    if (this.pendingChunks.length === 0) {
      return '';
    }

    let batchBytes = 0;
    const parts: string[] = [];
    while (this.pendingChunks.length > 0) {
      const head = this.pendingChunks[0];
      if (parts.length > 0 && batchBytes + head.chunk.length > this.maxBatchBytes) {
        break;
      }
      parts.push(head.chunk);
      this.pendingChunks.shift();
      this.pendingBytes -= head.chunk.length;
      batchBytes += head.chunk.length;
      if (batchBytes >= this.maxBatchBytes) {
        break;
      }
    }

    return parts.join('');
  }
}
