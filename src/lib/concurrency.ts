let activeCount = 0;
const waitQueue: Array<() => void> = [];

/**
 * Limits concurrent in-flight `task` executions to `cap` within this process.
 * In-process only (no Redis/Database) — sufficient because the follow-up path,
 * like the worker, runs inside this single-host app. A cap <= 0 disables
 * limiting entirely.
 */
export async function withConcurrencyLimit<T>(
  cap: number,
  task: () => Promise<T>
): Promise<T> {
  if (cap <= 0) {
    return task();
  }

  if (activeCount < cap) {
    activeCount += 1;
    try {
      return await task();
    } finally {
      release();
    }
  }

  await new Promise<void>((resolve) => {
    waitQueue.push(resolve);
  });

  try {
    return await task();
  } finally {
    release();
  }
}

function release(): void {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    activeCount -= 1;
  }
}