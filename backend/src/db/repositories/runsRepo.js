import { db, unwrap } from '../supabase.js';

/**
 * Start a run, failing if one is already in flight.
 *
 * `scrape_runs_single_active` is a partial unique index on status='running', so a
 * duplicate cron invocation gets a unique-violation (23505) instead of starting a
 * second overlapping run.
 */
export async function start(trigger) {
  const { data, error } = await db.from('scrape_runs').insert({ trigger }).select('*');
  if (error) {
    if (error.code === '23505') return { conflict: true, run: null };
    throw new Error(`start run: ${error.message}`);
  }
  return { conflict: false, run: data[0] };
}

export async function finish(id, { status, productsTotal, productsSuccess, productsFailed, notes }) {
  unwrap(
    await db
      .from('scrape_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
        products_total: productsTotal,
        products_success: productsSuccess,
        products_failed: productsFailed,
        notes: notes ?? null,
      })
      .eq('id', id),
    'finish run',
  );
}

/** Release a run that was abandoned (process killed mid-run) so cron can proceed. */
export async function reapStale(staleMs) {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const rows = unwrap(
    await db
      .from('scrape_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), notes: 'Reaped: run exceeded stale threshold' })
      .eq('status', 'running')
      .lt('started_at', cutoff)
      .select('id'),
    'reap stale runs',
  );
  return rows?.length ?? 0;
}

export async function recent(limit = 20) {
  return unwrap(
    await db.from('scrape_runs').select('*').order('started_at', { ascending: false }).limit(limit),
    'recent runs',
  ) ?? [];
}
