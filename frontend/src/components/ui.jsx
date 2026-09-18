import { humanFailureCode } from '../lib/format.js';

export const Spinner = () => <span className="spinner" aria-label="Loading" />;

export function Loading({ label = 'Loading…' }) {
  return <div className="empty"><Spinner /> <span style={{ marginLeft: 8 }}>{label}</span></div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error-box">
      <strong>Something went wrong.</strong> {error.message}
      {onRetry && <button className="btn btn-sm" style={{ marginLeft: 12 }} onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ title, children }) {
  return <div className="empty"><div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>{children}</div>;
}

/** Scrape outcome badge. "Retried" is shown distinctly so partial trouble stays visible. */
export function StatusBadge({ status }) {
  if (!status) return <span className="badge badge-muted">Never scraped</span>;
  if (status === 'success') return <span className="badge badge-success">Success</span>;
  if (status === 'retried') return <span className="badge badge-warn">Succeeded after retries</span>;
  return <span className="badge badge-danger">Failed</span>;
}

export function StockBadge({ latest }) {
  if (!latest) return <span className="badge badge-muted">Unknown</span>;
  return latest.inStock
    ? <span className="badge badge-success">In stock · {latest.stockQuantity}</span>
    : <span className="badge badge-danger">Out of stock</span>;
}

export function FailureReason({ code, message }) {
  if (!code) return null;
  return (
    <span className="small" style={{ color: 'var(--danger)' }}>
      {humanFailureCode(code)}{message ? ` — ${message}` : ''}
    </span>
  );
}
