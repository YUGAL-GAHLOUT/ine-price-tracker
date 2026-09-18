import { Link } from 'react-router-dom';
import { api, hasScrapeSecret } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { formatPrice, formatRelative } from '../lib/format.js';
import { Empty, ErrorBox, FailureReason, Loading, StatusBadge, StockBadge } from '../components/ui.jsx';
import { useState } from 'react';

export default function Dashboard() {
  const { loading, error, data, reload } = useAsync(() => api.listTracked(), []);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function scrapeNow(id) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.scrapeNow(id);
      await reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Loading label="Loading tracked products…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const items = data?.items ?? [];

  return (
    <>
      <h1>Dashboard</h1>
      <p className="page-sub">
        Tracked products are scraped every 2 hours. Prices shown are the most recent
        <strong> validated </strong> observation — a failed scrape never replaces them.
      </p>

      <ErrorBox error={actionError} />
      {!hasScrapeSecret && (
        <div className="notice">
          Manual scraping is disabled in this build because no scrape secret is bundled
          (it would be public). Scrapes run on the 2-hourly cron schedule, or via
          <span className="mono"> npm run scrape:once</span> on the backend.
        </div>
      )}

      {items.length === 0 ? (
        <div className="card">
          <Empty title="No products are being tracked yet">
            <p>Search the INE store and pick something to track.</p>
            <Link className="btn btn-primary" to="/add">Add a product</Link>
          </Empty>
        </div>
      ) : (
        <div className="grid">
          {items.map((p) => (
            <div className="card" key={p.id}>
              <div className="card-head">
                <div>
                  <div className="product-card-title">
                    <Link to={`/products/${p.id}`}>{p.name}</Link>
                  </div>
                  <div className="small muted">{p.brand} · {p.category} · SKU {p.sku}</div>
                </div>
                <StatusBadge status={p.latestScrape?.status} />
              </div>

              <div className="stat-row" style={{ marginBottom: 12 }}>
                <div>
                  <div className="stat-label">Current price</div>
                  <div className="stat-value big">{formatPrice(p.latest?.price)}</div>
                </div>
                <div>
                  <div className="stat-label">Stock</div>
                  <div className="stat-value"><StockBadge latest={p.latest} /></div>
                </div>
              </div>

              <div className="small muted" style={{ marginBottom: 4 }}>
                Last successful scrape: {formatRelative(p.last_success_at)}
                {p.latest?.crossChecked && ' · cross-checked'}
              </div>

              {/* When the latest attempt failed we say so, and keep showing the last
                  good price above rather than blanking it out. */}
              {p.latestScrape?.status === 'failed' && (
                <div className="small" style={{ marginBottom: 6 }}>
                  Latest attempt failed ({p.latestScrape.attempts} tries):{' '}
                  <FailureReason code={p.latestScrape.failureCode} />
                </div>
              )}

              <div className="row" style={{ marginTop: 10 }}>
                <Link className="btn btn-sm" to={`/products/${p.id}`}>History &amp; logs</Link>
                {hasScrapeSecret && (
                  <button className="btn btn-sm" disabled={busyId === p.id} onClick={() => scrapeNow(p.id)}>
                    {busyId === p.id ? 'Scraping…' : 'Scrape now'}
                  </button>
                )}
                {!p.is_active && <span className="badge badge-muted">Paused</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
