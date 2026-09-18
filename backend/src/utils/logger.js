/**
 * Minimal structured logger.
 *
 * One JSON object per line so Render's log viewer stays greppable, and so a scrape
 * run can be reconstructed after the fact. Never logs secrets: callers pass only
 * the fields listed at the call site.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

function emit(level, event, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  debug: (e, f) => emit('debug', e, f),
  info: (e, f) => emit('info', e, f),
  warn: (e, f) => emit('warn', e, f),
  error: (e, f) => emit('error', e, f),
};
