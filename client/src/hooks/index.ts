/** Small shared UI hooks. */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Async data loader with explicit loading/error/refetch semantics. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  // Tracks the most recently started request so stale (out-of-order) responses
  // cannot overwrite the result of a newer one (e.g. rapid search typing).
  const latestRunId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (quiet = false) => {
    const runId = ++latestRunId.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      // Ignore results from superseded requests.
      if (runId !== latestRunId.current) return;
      if (mounted.current) setData(result);
    } catch (err) {
      if (runId !== latestRunId.current) return;
      if (mounted.current) setError((err as Error)?.message ?? 'Something went wrong.');
    } finally {
      if (runId === latestRunId.current && mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, refetch: run, setData };
}

/** Debounce a rapidly-changing value (search boxes). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** Copy text to the clipboard with a transient "copied" flag. */
export function useCopyToClipboard(timeout = 1800) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(
    async (text: string, key = 'default') => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(key);
        setTimeout(() => setCopied(null), timeout);
      } catch {
        /* clipboard unavailable */
      }
    },
    [timeout],
  );
  return { copied, copy };
}