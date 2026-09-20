import { db, unwrap } from '../supabase.js';

/**
 * Start a run, failing if one is already in flight.
 *
 * `scrape_runs_single_active` is a partial unique index on status='running', so a
 * duplicate cron invocation gets a unique-violation (23505) instead of starting a
 * second overlapping run.
 */
export async function start(trigger, { source } = {}) {
  // `trigger` is the constrained enum the schema allows ('cron' | 'manual' | 'cli').
  // `source` is the finer distinction underneath it — a scheduled call, a boot
  // catch-up, or a forced run all arrive as 'cron' and are otherwise
  // indistinguishable in the history, which is exactly what makes a duplicate run
  // hard to attribute after the fact. It goes in `notes` rather than a new column
  // so this stays a code change, with no migration to apply to a live database.
  const notes = source ? `source: ${source}` : null;
  const { data, error } = await db.from('scrape_runs').insert({ trigger, notes }).select('*');
  if (error) {
    if (error.code === '23505') return { conflict: true, run: null };
    throw new Error(`start run: ${error.message}`);
  }
  return { conflict: false, run: data[0] };
}

export async function finish(id, { status, productsTotal, productsSuccess, productsFailed, notes }) {
  const patch = {
    status,
    completed_at: new Date().toISOString(),
    products_total: productsTotal,
    products_success: productsSuccess,
    products_failed: productsFailed,
  };
  // Only overwrite `notes` when this call actually has something to say. Writing
  // `null` by default would erase the source recorded at the start of the run,
  // which is the one thing that says which trigger produced it.
  if (notes) patch.notes = notes;
  unwrap(await db.from('scrape_runs').update(patch).eq('id', id), 'finish run');
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
