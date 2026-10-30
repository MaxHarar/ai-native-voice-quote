// In-memory sliding-window rate limiter. The service runs as a single Railway instance (SQLite on a
// volume), so process memory is the right scope; a multi-instance deploy would move this to Redis.

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit and reports whether the key is still within `limit` hits per `windowMs`. */
  hit(key: string, limit: number, windowMs: number): { allowed: boolean; count: number; retryAfterSecs: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => t - ts < windowMs);
    recent.push(t);
    this.hits.set(key, recent);
    const allowed = recent.length <= limit;
    const retryAfterSecs = allowed ? 0 : Math.ceil((windowMs - (t - recent[0]!)) / 1000);
    return { allowed, count: recent.length, retryAfterSecs };
  }

  /** Reads without recording. */
  count(key: string, windowMs: number): number {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((ts) => t - ts < windowMs).length;
  }

  /** Drops expired keys so memory stays bounded. */
  sweep(windowMs: number) {
    const t = this.now();
    for (const [k, v] of this.hits) {
      const recent = v.filter((ts) => t - ts < windowMs);
      if (recent.length) this.hits.set(k, recent);
      else this.hits.delete(k);
    }
  }

  get size() {
    return this.hits.size;
  }
}

/** First hop of X-Forwarded-For (Railway's edge sets it), else a placeholder. */
export function clientIp(header: (name: string) => string | undefined): string {
  return header("x-forwarded-for")?.split(",")[0]?.trim() || header("x-real-ip") || "unknown";
}
