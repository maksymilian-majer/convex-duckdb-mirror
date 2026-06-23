export async function poolMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let cancelled = false;
  let firstError: Error | undefined;

  async function worker(): Promise<void> {
    while (!cancelled && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        cancelled = true;
        firstError ??= error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  if (firstError) throw firstError;
  return results;
}
