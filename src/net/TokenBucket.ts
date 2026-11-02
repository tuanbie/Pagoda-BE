/** Classic token bucket: `rate` tokens/second, holding at most `burst`. */
export class TokenBucket {
  private tokens: number;
  private last = performance.now();

  constructor(
    private rate: number,
    private burst: number,
  ) {
    this.tokens = burst;
  }

  take(): boolean {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
