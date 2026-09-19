const BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');

/**
 * Low-privilege token for "Scrape now". It is bundled into this (public) build by
 * design: all it can do is re-scrape a product that is already tracked, and the
 * backend rate limits it. The cron secret is never shipped here.
 */
const SCRAPE_TOKEN = import.meta.env.VITE_MANUAL_SCRAPE_TOKEN ?? import.meta.env.VITE_SCRAPE_SECRET ?? '';

/** A read is quick; a manual scrape drives a real browser and can take minutes. */
const READ_TIMEOUT_MS = 45_000;
const SCRAPE_TIMEOUT_MS = 180_000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, secret = false, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (secret) {
    if (!SCRAPE_TOKEN) {
      throw new ApiError(401, 'no_secret',
        'No scrape token is configured in this build. Set VITE_MANUAL_SCRAPE_TOKEN, or trigger the scrape from cron-job.org / the CLI.');
    }
    headers.Authorization = `Bearer ${SCRAPE_TOKEN}`;
  }

  // Without this a request can hang forever — a sleeping Render instance, or a
  // manual scrape that is genuinely still working — leaving a button spinning
  // with no way back. An explicit abort gives us a message we can act on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method, headers, signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new ApiError(0, 'timeout',
        method === 'POST'
          ? 'The request is taking longer than expected. The scrape may still be running on the server — reload in a moment to see the result.'
          : `The API at ${BASE} did not respond in time. If it is on a free tier it may be waking up; try again.`);
    }
    throw new ApiError(0, 'network_error', `Cannot reach the API at ${BASE}. Is the backend running?`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    throw new ApiError(res.status, payload?.error?.code ?? 'http_error',
      payload?.error?.message ?? `Request failed with status ${res.status}`);
  }
  return payload;
}

export const api = {
  health: () => request('/health'),
  search: (q, limit = 25) => request(`/products/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  listTracked: () => request('/tracked-products'),
  track: (storeProductId, scrapeIntervalMinutes) =>
    request('/tracked-products', { method: 'POST', body: { storeProductId, ...(scrapeIntervalMinutes ? { scrapeIntervalMinutes } : {}) } }),
  getTracked: (id) => request(`/tracked-products/${id}`),
  updateTracked: (id, patch) => request(`/tracked-products/${id}`, { method: 'PATCH', body: patch }),
  untrack: (id) => request(`/tracked-products/${id}`, { method: 'DELETE' }),
  history: (id) => request(`/tracked-products/${id}/history`),
  logs: (id) => request(`/tracked-products/${id}/logs`),
  alerts: (id) => request(`/tracked-products/${id}/alerts`),
  scrapeNow: (id) =>
    request(`/tracked-products/${id}/scrape`, { method: 'POST', secret: true, timeoutMs: SCRAPE_TIMEOUT_MS }),
  status: () => request('/status'),
};

export const hasScrapeSecret = Boolean(SCRAPE_TOKEN);
export const apiBaseUrl = BASE;
