/**
 * Global brute-force brake for the single shared password.
 *
 * Per-IP rate limiting alone is weak here: behind the web app's proxy every request can
 * look like it comes from one address, and a forged X-Forwarded-For can dodge it. Since
 * this app has exactly one user, we also cap *total* failed attempts in a window. Trade-off:
 * an attacker can briefly lock the owner out; they cannot get in.
 */
export class LoginThrottle {
  private failures: number[] = [];

  constructor(
    private readonly maxFailures = 20,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    this.failures = this.failures.filter((time) => time > cutoff);
  }

  /** Milliseconds until another attempt is allowed, or 0 when attempts are open. */
  retryAfterMs(now = Date.now()): number {
    this.prune(now);
    if (this.failures.length < this.maxFailures) return 0;
    const oldest = this.failures[0] ?? now;
    return Math.max(0, oldest + this.windowMs - now);
  }

  recordFailure(now = Date.now()): void {
    this.prune(now);
    this.failures.push(now);
  }
}
