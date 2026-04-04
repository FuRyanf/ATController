export const STREAM_REPAIR_THRESHOLD_BYTES = 48 * 1024;
export const STREAM_REPAIR_LATENCY_THRESHOLD_MS = 96;
export const STREAM_REPAIR_COOLDOWN_MS = 1_200;
// During sparse output (long builds), send a SIGWINCH to the CLI so it
// redraws its status bar and corrects accumulated positioning drift.
export const STREAM_REPAIR_IDLE_REFLOW_MS = 5_000;

interface TerminalStreamRepairInput {
  autoFollow: boolean;
  bytesSinceLastRepair: number;
  lastQueueLatencyMs: number;
  lastRepairAtMs: number;
  nowMs: number;
}

export function shouldScheduleTerminalStreamRepair({
  autoFollow,
  bytesSinceLastRepair,
  lastQueueLatencyMs,
  lastRepairAtMs,
  nowMs
}: TerminalStreamRepairInput): boolean {
  if (!autoFollow) {
    return false;
  }

  if (nowMs - lastRepairAtMs < STREAM_REPAIR_COOLDOWN_MS) {
    return false;
  }

  return (
    bytesSinceLastRepair >= STREAM_REPAIR_THRESHOLD_BYTES ||
    lastQueueLatencyMs >= STREAM_REPAIR_LATENCY_THRESHOLD_MS ||
    (bytesSinceLastRepair > 0 && nowMs - lastRepairAtMs >= STREAM_REPAIR_IDLE_REFLOW_MS)
  );
}
