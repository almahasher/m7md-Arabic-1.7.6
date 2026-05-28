export class CircuitBreaker {
  constructor(limit = 4, resetMs = 30_000) {
    this.limit = limit;
    this.resetMs = resetMs;
    this.failures = 0;
    this.state = 'CLOSED';
    this.nextAttempt = null;
  }

  canExecute() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'HALF_OPEN') return true;

    if (this.nextAttempt && Date.now() >= this.nextAttempt) {
      this.state = 'HALF_OPEN';
      return true;
    }

    return false;
  }

  success() {
    this.failures = 0;
    this.state = 'CLOSED';
    this.nextAttempt = null;
  }

  fail() {
    this.failures += 1;

    if (this.failures >= this.limit) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetMs;
    }
  }

  getStatus() {
    return {
      state: this.state,
      failures: this.failures,
      nextAttempt: this.nextAttempt ? new Date(this.nextAttempt).toISOString() : null,
    };
  }
}
