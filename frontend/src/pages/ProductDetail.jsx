import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, hasScrapeSecret } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { formatDateTime, formatDuration, formatPrice, formatRelative, humanFailureCode } from '../lib/format.js';
import { Empty, ErrorBox, Loading, StatusBadge, StockBadge } from '../components/ui.jsx';
import HistoryChart from '../components/HistoryChart.jsx';

export default function ProductDetail() {
  const { id } = useParams();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const { loading, error, data, reload } = useAsync(
    async () => {
      const [product, history, logs, alerts] = await Promise.all([
        api.getTracked(id), api.history(id), api.logs(id), api.alerts(id),
      ]);
      return { product: product.product, history: history.items, logs: logs.items, alerts: alerts.items };
    },
    [id],
  );

  async function scrapeNow() {
    setBusy(true);
    setActionError(null);
    try { await api.scrapeNow(id); await reload(); }
    catch (e) { setActionError(e); }
    finally { setBusy(false); }
  }

  if (loading) return <Loading label="Loading product…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const { product: p, history, logs, alerts } = data;
  const failed = p.latestScrape?.status === 'failed';

  return (
    <>
      <p className="small"><Link to="/">← Dashboard</Link></p>
      <h1>{p.name}</h1>
      <p className="page-sub">
        {p.brand} · {p.category} · SKU {p.sku} ·{' '}
        <a href={p.url} target="_blank" rel="noreferrer noopener">View on the store ↗</a>
      </p>

      <ErrorBox error={actionError} />

      {/* ---- Current state ------------------------------------------------ */}
      <div className="card">
        <div className="card-head">
          <h2>Current state</h2>
          <div className="row">
            <StatusBadge status={p.latestScrape?.status} />
            {hasScrapeSecret && (
              <button className="btn btn-sm" onClick={scrapeNow} disabled={busy}>
                {busy ? 'Scraping…' : 'Scrape now'}
              </button>
            )}
          </div>
        </div>

        <div className="stat-row">
          <div>
            <div className="stat-label">{failed ? 'Last known price' : 'Current price'}</div>
            <div className="stat-value big">{formatPrice(p.latest?.price)}</div>
          </div>
          <div>
            <div className="stat-label">Stock</div>
            <div className="stat-value"><StockBadge latest={p.latest} /></div>
          </div>
          <div>
            <div className="stat-label">MRP</div>
            <div className="stat-value">{formatPrice(p.latest?.mrp)}</div>
          </div>
          <div>
            <div className="stat-label">Last successful scrape</div>
            <div className="stat-value">{formatRelative(p.last_success_at)}</div>
          </div>
          <div>
            <div className="stat-label">Scrape interval</div>
            <div className="stat-value">{p.scrape_interval_minutes / 60}h</div>
          </div>
        </div>

        {failed && (
          <div className="error-box" style={{ marginTop: 14, marginBottom: 0 }}>
            <strong>Latest scrape failed</strong> after {p.latestScrape.attempts} attempt
            {p.latestScrape.attempts === 1 ? '' : 's'} — {humanFailureCode(p.latestScrape.failureCode)}.
            The price above is the last value that passed validation
            ({formatDateTime(p.latest?.scrapedAt)}); it was not overwritten.
          </div>
        )}
      </div>

      {/* ---- Alerts ------------------------------------------------------- */}
      {alerts.length > 0 && (
        <div className="card">
          <h2>Alerts</h2>
          {alerts.slice(0, 6).map((a) => (
            <div className="result-item" key={a.id}>
              <div>
                <span className={`badge ${a.type === 'price_drop' || a.type === 'back_in_stock' ? 'badge-success' : a.type === 'structure_change' ? 'badge-warn' : 'badge-muted'}`}>
                  {humanFailureCode(a.type)}
                </span>
                <span style={{ marginLeft: 10 }}>{a.message}</span>
              </div>
              <span className="small muted">{formatRelative(a.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ---- History ------------------------------------------------------ */}
      <div className="card">
        <div className="card-head">
          <h2>Price &amp; stock history</h2>
          <span className="small muted">{history.length} validated observation{history.length === 1 ? '' : 's'}</span>
        </div>

        {history.length === 0 ? (
          <Empty title="No history yet">
            History appears after the first successful scrape. The next scheduled run is
            within 2 hours of the last one.
          </Empty>
        ) : (
          <>
            <HistoryChart items={history} />
            <div className="table-scroll" style={{ marginTop: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>Scraped at</th><th>Price</th><th>MRP</th><th>Stock</th><th>Seller</th><th>Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().slice(0, 60).map((h, i) => (
                    <tr key={`${h.scrapedAt}-${i}`}>
                      <td className="mono">{formatDateTime(h.scrapedAt)}</td>
                      <td><strong>{formatPrice(h.price)}</strong></td>
                      <td className="muted">{formatPrice(h.mrp)}</td>
                      <td>{h.inStock ? `${h.stockQuantity} in stock` : 'Out of stock'}</td>
                      <td className="muted">{h.seller ?? '—'}</td>
                      <td>{h.crossChecked
                        ? <span className="badge badge-success">Cross-checked</span>
                        : <span className="badge badge-muted">DOM only</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ---- Scrape log --------------------------------------------------- */}
      <div className="card">
        <div className="card-head">
          <h2>Scrape log</h2>
          <span className="small muted">every attempt, including failures</span>
        </div>

        {logs.length === 0 ? (
          <Empty title="No scrape attempts recorded yet" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th><th>Outcome</th><th>Attempts</th><th>Duration</th><th>Result / reason</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{formatDateTime(l.startedAt)}</td>
                    <td><StatusBadge status={l.status} /></td>
                    <td>{l.attempts}</td>
                    <td className="muted">{formatDuration(l.durationMs)}</td>
                    <td>
                      {l.status === 'failed' ? (
                        <span style={{ color: 'var(--danger)' }}>
                          {humanFailureCode(l.failureCode)}
                          {l.errorMessage && <span className="small muted"> — {l.errorMessage}</span>}
                        </span>
                      ) : (
                        <>{formatPrice(l.scrapedPrice)} · {l.scrapedStock} in stock</>
                      )}

                      {/* Per-attempt breakdown: a run that eventually succeeded still
                          shows the attempts that failed on the way. */}
                      {l.attemptTrail?.length > 1 && (
                        <ul className="attempt-trail">
                          {l.attemptTrail.map((a) => (
                            <li key={a.attempt}>
                              Attempt {a.attempt}: {a.ok ? 'succeeded' : `failed — ${humanFailureCode(a.failureCode)}`}
                              {' '}({formatDuration(a.durationMs)})
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
