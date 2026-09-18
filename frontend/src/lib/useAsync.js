import { useCallback, useEffect, useState } from 'react';

/**
 * Small data-fetching hook giving every page the same loading / error / empty
 * states without pulling in a data library.
 */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await fn() });
    } catch (error) {
      setState({ loading: false, error, data: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { run(); }, [run]);

  return { ...state, reload: run };
}
