export type RenderJob = () => Promise<void>;

export interface RenderCoordinatorOptions {
  debounceMs: number;
  coalesceMs: number;
}

/**
 * Coordinates preview refresh execution with three triggers:
 *  - schedule(): immediate fire-and-forget (save / dependency change).
 *  - scheduleDebounced(): debounced typing refresh.
 *  - A coalescing safeguard that forces a refresh after coalesceMs while the
 *    user keeps typing, so rapid edits never starve the preview entirely.
 *
 * Only one job is allowed in flight at a time. Newer jobs queued while one is
 * running replace any previously queued job, so stale work is cancelled.
 */
export class RenderCoordinator {
  private pendingTimer: NodeJS.Timeout | undefined;
  private coalesceTimer: NodeJS.Timeout | undefined;
  private queuedJob: RenderJob | undefined;
  private inFlight = false;
  private disposed = false;

  constructor(private readonly options: RenderCoordinatorOptions) {}

  /** Queue an authoritative refresh (save / dependency change). */
  public schedule(job: RenderJob): void {
    if (this.disposed) {
      return;
    }
    this.clearPendingTimer();
    this.clearCoalesceTimer();
    this.enqueue(job);
  }

  /** Queue a debounced typing refresh. Collapses rapid edits into one render. */
  public scheduleDebounced(job: RenderJob): void {
    if (this.disposed) {
      return;
    }

    this.queuedJob = job;
    this.clearPendingTimer();
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      const next = this.queuedJob;
      this.queuedJob = undefined;
      if (next) {
        this.clearCoalesceTimer();
        this.enqueue(next);
      }
    }, this.options.debounceMs);

    if (!this.coalesceTimer) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = undefined;
        const latest = this.queuedJob;
        if (latest) {
          this.clearPendingTimer();
          this.queuedJob = undefined;
          this.enqueue(latest);
        }
      }, this.options.coalesceMs);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.clearPendingTimer();
    this.clearCoalesceTimer();
    this.queuedJob = undefined;
  }

  private enqueue(job: RenderJob): void {
    if (this.inFlight) {
      // Replace queued job so only the latest runs next (stale cancel).
      this.queuedJob = job;
      return;
    }
    void this.runJob(job);
  }

  private async runJob(job: RenderJob): Promise<void> {
    this.inFlight = true;
    try {
      await job();
    } catch (error) {
      console.error("[Flare Preview] render job failed", error);
    } finally {
      this.inFlight = false;
      if (this.disposed) {
        this.queuedJob = undefined;
        return;
      }
      const next = this.queuedJob;
      this.queuedJob = undefined;
      if (next) {
        void this.runJob(next);
      }
    }
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }

  private clearCoalesceTimer(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
  }
}
