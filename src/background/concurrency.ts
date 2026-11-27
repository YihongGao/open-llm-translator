// Caps simultaneous API requests across all tabs and all features (page
// translation and image translation share one budget).

const MAX_CONCURRENT_REQUESTS = 3;
let running = 0;
const waiters: Array<() => void> = [];

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_REQUESTS) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}
