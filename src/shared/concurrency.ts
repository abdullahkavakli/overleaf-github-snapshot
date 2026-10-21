// Small async helpers shared by the popup and the content script.

// Runs `worker` over `items` with at most `limit` calls in flight and
// returns the results in input order. This is request pipelining, not
// parallel computation: the work is network-bound and JS stays
// single-threaded. If a worker throws, no new items start and the call
// rejects with that error once the in-flight ones settle. Callers that want
// per-item failures should catch inside `worker`.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < width; i++) lanes.push(lane());
  await Promise.all(lanes);
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}

// Splits `items` into consecutive slices of at most `size` elements.
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
