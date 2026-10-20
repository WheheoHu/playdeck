import { WATCHED_FRACTION } from './playback';
import type { TimelineReport, TimelineState } from './plex/playback';

/** How often a playing session reports, as Plex's own players do. */
export const TIMELINE_INTERVAL_MS = 10_000;

/**
 * Turns the player's progress (seconds) into Plex timeline reports (milliseconds): on every change of
 * state, and every 10 s while playing. Reports go out one at a time; a failed one is not retried, since
 * the next carries the newer position anyway.
 */
export class TimelineReporter {
  private state: TimelineState | undefined;
  private sentAt = -Infinity;
  private sending: Promise<void> = Promise.resolve();
  private position = 0;
  private duration: number;

  constructor(
    private readonly ratingKey: string,
    /** The server's duration, until the player reports the file's. */
    durationMs: number | undefined,
    private readonly send: (report: TimelineReport) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.duration = durationMs ?? 0;
  }

  progress(positionSeconds: number, durationSeconds: number, paused: boolean): void {
    this.update(positionSeconds, durationSeconds);
    const state: TimelineState = paused ? 'paused' : 'playing';
    if (state !== this.state || this.now() - this.sentAt >= TIMELINE_INTERVAL_MS) this.report(state);
  }

  /** The final report. Returns whether the viewer got far enough for the item to count as watched. */
  end(positionSeconds: number, durationSeconds: number, reachedEnd: boolean): boolean {
    this.update(positionSeconds, durationSeconds);
    const watched = reachedEnd || (this.duration > 0 && this.position >= this.duration * WATCHED_FRACTION);
    this.report('stopped', watched ? this.duration : this.position);
    return watched;
  }

  private update(positionSeconds: number, durationSeconds: number): void {
    this.position = Math.max(0, positionSeconds * 1000);
    if (durationSeconds > 0) this.duration = durationSeconds * 1000;
  }

  /** Resolves once the latest report is done, e.g. before reloading the item's resume offset. */
  settled(): Promise<void> {
    return this.sending;
  }

  private report(state: TimelineState, time = this.position): void {
    this.state = state;
    this.sentAt = this.now();
    this.sending = this.send({ ratingKey: this.ratingKey, state, time, duration: this.duration }).catch((error: unknown) =>
      console.warn('timeline report failed:', error),
    );
  }
}
