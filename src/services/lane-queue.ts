/**
 * Lane Queue — Two-level concurrency control aligned with OpenClaw.
 *
 * Architecture (from OpenClaw):
 * - Session Lane: per-session serialization (prevents concurrent writes to same session)
 * - Global Lane: caps total concurrent model calls across all sessions
 *
 * Pure TypeScript + promises, no external dependencies.
 */

import type { LaneQueueStatus } from '../types.js';

interface QueueEntry {
  resolve: () => void;
}

export class LaneQueue {
  // Session lanes: serialize operations per session key
  // Each session stores a chain of promises; new operations wait for the previous one
  private sessionLanes = new Map<string, Promise<void>>();

  // Global lane: semaphore with max concurrent limit
  private globalRunning = 0;
  private globalMax: number;
  private globalQueue: QueueEntry[] = [];

  constructor(maxConcurrent = 4) {
    this.globalMax = maxConcurrent;
  }

  /**
   * Acquire both session and global lane before executing.
   * Returns a release function that MUST be called when done.
   *
   * Usage:
   *   const release = await queue.acquire(sessionId);
   *   try { ... } finally { release(); }
   */
  async acquire(sessionKey: string): Promise<() => void> {
    // Step 1: Wait for session lane (serialize per session)
    const sessionRelease = await this.acquireSessionLane(sessionKey);

    // Step 2: Wait for global lane (respect concurrency cap)
    await this.acquireGlobalLane();

    // Return combined release function
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseGlobalLane();
      sessionRelease();
    };
  }

  // ---- Session Lane ----

  private acquireSessionLane(key: string): Promise<() => void> {
    const prev = this.sessionLanes.get(key) || Promise.resolve();
    let releaseFn: () => void;
    const next = new Promise<void>((resolve) => { releaseFn = resolve; });

    // Chain: wait for previous to complete, then we occupy the lane
    const wait = prev.then(() => releaseFn!);
    this.sessionLanes.set(key, next);

    return wait;
  }

  // ---- Global Lane (Semaphore) ----

  private acquireGlobalLane(): Promise<void> {
    if (this.globalRunning < this.globalMax) {
      this.globalRunning++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.globalQueue.push({ resolve });
    });
  }

  private releaseGlobalLane() {
    if (this.globalQueue.length > 0) {
      const next = this.globalQueue.shift()!;
      next.resolve(); // Don't decrement; the new task takes our slot
    } else {
      this.globalRunning--;
    }
  }

  /**
   * Remove a session lane entry. Call after session close to prevent Map growth.
   * Safe to call even if the session has pending operations (they'll resolve naturally).
   */
  removeSession(key: string): void {
    this.sessionLanes.delete(key);
  }

  // ---- Status ----

  getStatus(): LaneQueueStatus {
    const sessionLanes: LaneQueueStatus['sessionLanes'] = [];
    for (const [key] of this.sessionLanes) {
      sessionLanes.push({ key, pending: 1 }); // simplified
    }
    return {
      sessionLanes,
      globalLane: {
        running: this.globalRunning,
        max: this.globalMax,
        queued: this.globalQueue.length,
      },
    };
  }

  /**
   * Update max concurrent limit.
   */
  setMaxConcurrent(max: number) {
    this.globalMax = Math.max(1, max);
    // If we raised the limit, drain queue
    while (this.globalRunning < this.globalMax && this.globalQueue.length > 0) {
      this.globalRunning++;
      const next = this.globalQueue.shift()!;
      next.resolve();
    }
  }

  getMaxConcurrent(): number {
    return this.globalMax;
  }
}
