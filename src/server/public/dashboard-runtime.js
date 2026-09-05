'use strict';

// Shared by the browser and the dependency-free dashboard regression tests.
(function expose(root) {
  function createJsonClient({ fetchImpl, timeoutMs = 8_000 } = {}) {
    return async function json(url, options = {}) {
      const controller = new AbortController();
      const parentSignal = options.signal;
      let rejectCancellation;
      const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
      const cancel = (error) => {
        controller.abort();
        rejectCancellation(error);
      };
      const abort = () => {
        const error = new Error('请求已取消');
        error.name = 'AbortError';
        cancel(error);
      };
      const timer = setTimeout(() => {
        const error = new Error('请求超时，可自动重试');
        error.name = 'TimeoutError';
        cancel(error);
      }, options.timeoutMs ?? timeoutMs);
      parentSignal?.addEventListener('abort', abort, { once: true });
      if (parentSignal?.aborted) abort();
      try {
        const request = (async () => {
          const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })();
        // Racing also releases the refresh lock if a transport ignores abort.
        return await Promise.race([request, cancelled]);
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
      }
    };
  }

  function normalizeLiveCatalog(rows) {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      if (!row?.id || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    }).sort((left, right) => (
      Number(left.enabled === false || left.entryEnabled === false)
      - Number(right.enabled === false || right.entryEnabled === false)
    ));
  }

  function pickLiveStrategy(rows, currentId) {
    return rows.some((row) => row.id === currentId) ? currentId : rows[0]?.id || null;
  }

  const api = { createJsonClient, normalizeLiveCatalog, pickLiveStrategy };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DashboardRuntime = api;
})(typeof globalThis === 'object' ? globalThis : this);
