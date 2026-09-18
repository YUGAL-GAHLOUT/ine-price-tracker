import { api, apiBaseUrl } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { formatDateTime, formatDuration, formatRelative, humanFailureCode } from '../lib/format.js';
import { Empty, ErrorBox, Loading, StatusBadge } from '../components/ui.jsx';

/** Cross-product view of scrape runs, so the health of the scheduler is visible. */
export default function Activity() {
  const { loading, error, data, reload } = useAsync(() => api.status(), []);

  if (loading) return <Loading label="Loading activity…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const { runs = [], recentLogs = [], alerts = [] } = data ?? {};

  return (
    <>
      <h1>Activity</h1>
      <p className="page-sub">
        Scrape runs across all tracked products. API: <span className="mono">{apiBaseUrl}</span>
      </p>

      <div className="card">
        <div className="card-head">
          <h2>Recent runs</h2>
          <button className="btn btn-sm" onClick={reload}>Refresh</button>
        </div>
        {runs.length === 0 ? <Empty title="No runs yet" /> : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Started</th><th>Trigger</th><th>Status</th><th>Products</th><th>Succeeded</th><th>Failed</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{formatDateTime(r.started_at)} <span className="muted">({formatRelative(r.started_at)})</span></td>
                    <td><span className="badge badge-muted">{r.trigger}</span></td>
                    <td>
                      {r.status === 'completed' ? <span className="badge badge-success">Completed</span>
                        : r.status === 'running' ? <span className="badge badge-warn">Running</span>
                        : <span className="badge badge-danger">Failed</span>}
                    </td>
                    <td>{r.products_total}</td>
                    <td style={{ color: 'var(--success)' }}>{r.products_success}</td>
                    <td style={{ color: r.products_failed ? 'var(--danger)' : undefined }}>{r.products_failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Recent scrape attempts</h2>
        {recentLogs.length === 0 ? <Empty title="Nothing logged yet" /> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Started</th><th>Outcome</th><th>Attempts</th><th>Duration</th><th>Detail</th></tr></thead>
              <tbody>
                {recentLogs.slice(0, 40).map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{formatDateTime(l.started_at)}</td>
                    <td><StatusBadge status={l.status} /></td>
                    <td>{l.attempts}</td>
                    <td className="muted">{formatDuration(l.duration_ms)}</td>
                    <td>
                      {l.status === 'failed'
                        ? <span style={{ color: 'var(--danger)' }}>{humanFailureCode(l.failure_code)}</span>
                        : <span className="muted">₹{l.scraped_price} · {l.scraped_stock} in stock</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {alerts.length > 0 && (
        <div className="card">
          <h2>Recent alerts</h2>
          {alerts.map((a) => (
            <div className="result-item" key={a.id}>
              <div><span className="badge badge-muted">{humanFailureCode(a.type)}</span>
                <span style={{ marginLeft: 10 }}>{a.message}</span></div>
              <span className="small muted">{formatRelative(a.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
