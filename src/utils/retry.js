function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultShouldRetry(err) {
  const status = err?.response?.status;

  if (!status) return true;              // Network / timeout.
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;                          // 4xx auth / bad request should fail fast.
}

/**
 * Retry with exponential backoff and light jitter.
 */
export async function retry(fn, retries = 2, baseMs = 250, shouldRetry = defaultShouldRetry) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLast = attempt === retries - 1;
      if (isLast || !shouldRetry(err)) break;

      const exponential = baseMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * Math.max(baseMs, 1));
      await sleep(exponential + jitter);
    }
  }

  throw lastError;
}
