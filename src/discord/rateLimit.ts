export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private nextSweepAt = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) {
      throw new Error("maxPerWindow must be a positive integer");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be positive");
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error("maxKeys must be a positive integer");
    }
  }

  /** Returns true if the request is allowed (and records it). */
  tryConsume(key: string, now = Date.now()): boolean {
    if (now >= this.nextSweepAt) {
      this.pruneExpired(now);
      this.nextSweepAt = now + Math.min(this.windowMs, 60_000);
    }

    const cutoff = now - this.windowMs;
    const prior = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (prior.length >= this.maxPerWindow) {
      this.hits.set(key, prior);
      return false;
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      this.pruneExpired(now);
      if (this.hits.size >= this.maxKeys) return false;
    }
    prior.push(now);
    this.hits.set(key, prior);
    return true;
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.hits.clear();
      this.nextSweepAt = 0;
    }
    else this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) this.hits.delete(key);
      else if (active.length !== timestamps.length) this.hits.set(key, active);
    }
  }
}
