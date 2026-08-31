import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

let cache: SupabaseClient | null = null;

/** Cliente Supabase com a service role key — uso exclusivo em backend. */
export function getSupabase(): SupabaseClient {
  if (!cache) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
    cache = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return cache;
}
