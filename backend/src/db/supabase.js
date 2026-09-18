import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

/**
 * Service-role client. This key bypasses RLS and must never reach the browser —
 * it only ever lives in the backend's environment.
 */
export const db = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Unwrap a supabase-js result, turning its error shape into a thrown Error. */
export function unwrap({ data, error }, context) {
  if (error) {
    const e = new Error(`${context}: ${error.message}`);
    e.cause = error;
    e.pgCode = error.code;
    throw e;
  }
  return data;
}
