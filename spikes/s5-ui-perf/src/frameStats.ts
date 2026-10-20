export interface IntervalStats {
  frames: number;
  durationMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  dropped: number;
  droppedRatio: number;
}

export interface Budget {
  refreshHz: number;
  p95LimitMs: number;
  dropThresholdMs: number;
}

/** One refresh period for p95 (with 5% for timestamp jitter); a drop is an interval over 1.5 periods. */
export function budgetFor(refreshHz: number): Budget {
  const period = 1000 / refreshHz;
  return { refreshHz, p95LimitMs: period * 1.05, dropThresholdMs: period * 1.5 };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

export function summarize(intervals: number[], budget: Budget): IntervalStats & { pass: boolean } {
  const sorted = [...intervals].sort((a, b) => a - b);
  const dropped = intervals.filter((interval) => interval > budget.dropThresholdMs).length;
  const p95Ms = percentile(sorted, 0.95);
  const stats = {
    frames: intervals.length,
    durationMs: intervals.reduce((sum, interval) => sum + interval, 0),
    medianMs: percentile(sorted, 0.5),
    p95Ms,
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
    dropped,
    droppedRatio: intervals.length ? dropped / intervals.length : 0,
  };
  return { ...stats, pass: p95Ms <= budget.p95LimitMs && stats.droppedRatio <= 0.01 };
}

/** Records requestAnimationFrame timestamps and long animation frames, segmented by harness phase. */
export class FrameRecorder {
  private times: number[] = [];
  private marks: { phase: string; index: number }[] = [];
  private longFrames: { phase: string; durationMs: number; blockingMs: number }[] = [];
  private running = false;
  private observer?: PerformanceObserver;

  start(): void {
    this.running = true;
    this.observer = new PerformanceObserver((list) => {
      const phase = this.marks.at(-1)?.phase ?? 'pre';
      for (const entry of list.getEntries()) {
        const blockingMs = (entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0;
        this.longFrames.push({ phase, durationMs: entry.duration, blockingMs });
      }
    });
    this.observer.observe({ type: 'long-animation-frame', buffered: false });
    const tick = (time: number) => {
      if (!this.running) return;
      this.times.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  mark(phase: string): void {
    this.marks.push({ phase, index: this.times.length });
  }

  stop(budget: Budget) {
    this.running = false;
    this.observer?.disconnect();
    const intervals = (from: number, to: number) =>
      this.times.slice(from, to).flatMap((time, i, all) => (i ? [time - all[i - 1]] : []));
    const phases = this.marks.map((mark, i) => ({
      phase: mark.phase,
      ...summarize(intervals(mark.index, this.marks[i + 1]?.index ?? this.times.length), budget),
      longAnimationFrames: this.longFrames.filter((frame) => frame.phase === mark.phase).length,
    }));
    const first = this.marks[0]?.index ?? 0;
    return {
      budget,
      overall: summarize(intervals(first, this.times.length), budget),
      phases,
      longAnimationFrames: this.longFrames,
    };
  }
}
