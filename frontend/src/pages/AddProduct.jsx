import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Empty, ErrorBox, Loading } from '../components/ui.jsx';

export default function AddProduct() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ loading: false, error: null, result: null });
  const [trackingId, setTrackingId] = useState(null);
  const [trackError, setTrackError] = useState(null);

  async function search(e) {
    e?.preventDefault();
    // Guard against a double submit: Enter while a search is already running
    // would fire a second identical request and race the first one's result.
    if (!query.trim() || state.loading) return;
    setState({ loading: true, error: null, result: null });
    setTrackError(null);
    try {
      setState({ loading: false, error: null, result: await api.search(query.trim()) });
    } catch (error) {
      setState({ loading: false, error, result: null });
    }
  }

  async function track(storeProductId) {
    setTrackingId(storeProductId);
    setTrackError(null);
    try {
      const { product } = await api.track(storeProductId);
      navigate(`/products/${product.id}`);
    } catch (e) {
      setTrackError(e);
    } finally {
      setTrackingId(null);
    }
  }

  const items = state.result?.items ?? [];

  return (
    <>
      <h1>Add a product</h1>
      <p className="page-sub">
        Search the INE mock store by partial or full product name (brand and SKU match too).
      </p>

      <div className="card">
        <form className="row" onSubmit={search}>
          <input
            className="input" style={{ flex: '1 1 260px' }}
            placeholder="e.g. helix, receiver, Vista Monitor Studio, HEL-10088"
            value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
            // Enter is how people actually search. Handled explicitly rather than
            // relying on the form's implicit submission, which does not fire in
            // every browser once the submit button has been disabled and re-enabled.
            onKeyDown={(e) => { if (e.key === 'Enter') search(e); }}
          />
          <button className="btn btn-primary" type="submit" disabled={state.loading || !query.trim()}>
            {state.loading ? 'Searching…' : 'Search'}
          </button>
        </form>
      </div>

      <ErrorBox error={state.error} />
      <ErrorBox error={trackError} />

      {state.loading && <Loading label="Searching the store catalogue…" />}

      {state.result && (
        <div className="card">
          <div className="card-head">
            <h2>{items.length} match{items.length === 1 ? '' : 'es'} for “{state.result.query}”</h2>
            <span className="small muted">
              {state.result.source === 'cache'
                ? `from the mirrored catalogue (${state.result.catalogSize} products)`
                : 'queried the store live'}
            </span>
          </div>

          {items.length === 0 ? (
            <Empty title="No products matched">Try a shorter or different term.</Empty>
          ) : (
            items.map((p) => (
              <div className="result-item" key={p.store_product_id}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="small muted">
                    {p.brand} · {p.category} · SKU {p.sku} · store id {p.store_product_id}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={trackingId === p.store_product_id}
                  onClick={() => track(p.store_product_id)}
                >
                  {trackingId === p.store_product_id ? 'Adding…' : 'Track'}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
