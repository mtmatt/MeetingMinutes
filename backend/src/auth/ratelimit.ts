/**
 * Small in-memory fixed-window limiter. Good enough for a single-process
 * deployment; state resets on restart, which is acceptable for brute-force
 * throttling.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns seconds until retry is allowed, or 0 if the key is under the limit. */
  check(key: string): number {
    const entry = this.hits.get(key);
    const t = Date.now();
    if (!entry || entry.resetAt <= t) return 0;
    return entry.count >= this.limit ? Math.ceil((entry.resetAt - t) / 1000) : 0;
  }

  hit(key: string): void {
    const t = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
    } else {
      entry.count++;
    }
    if (this.hits.size > 50_000) this.sweep();
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep() {
    const t = Date.now();
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** Failed logins per client IP. */
export const loginIpLimiter = new RateLimiter(20, 15 * 60 * 1000);
/** Failed logins per username (protects a single account from distributed guessing). */
export const loginUserLimiter = new RateLimiter(8, 15 * 60 * 1000);
/** Invite / setup token attempts per IP. */
export const tokenLimiter = new RateLimiter(30, 15 * 60 * 1000);
