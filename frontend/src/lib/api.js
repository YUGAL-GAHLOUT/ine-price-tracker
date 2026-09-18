const BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const SCRAPE_SECRET = import.meta.env.VITE_SCRAPE_SECRET ?? '';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, secret = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (secret) {
    if (!SCRAPE_SECRET) {
      throw new ApiError(401, 'no_secret',
        'No scrape secret is configured in this build. Set VITE_SCRAPE_SECRET for local use, or trigger the scrape from cron-job.org / the CLI.');
    }
    headers.Authorization = `Bearer ${SCRAPE_SECRET}`;
  }

  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'network_error', `Cannot reach the API at ${BASE}. Is the backend running?`);
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
  scrapeNow: (id) => request(`/tracked-products/${id}/scrape`, { method: 'POST', secret: true }),
  status: () => request('/status'),
};

export const hasScrapeSecret = Boolean(SCRAPE_SECRET);
export const apiBaseUrl = BASE;
