import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _admin: SupabaseClient | null = null;

// Vercel Marketplace's Supabase integration provisions:
//   POSTGRES_URL                         (direct conn — unused here)
//   SUPABASE_URL                         (server-only, mirrors NEXT_PUBLIC_*)
//   NEXT_PUBLIC_SUPABASE_URL             (browser-safe URL)
//   SUPABASE_SERVICE_ROLE_KEY            (server-only — full access)
//   NEXT_PUBLIC_SUPABASE_ANON_KEY        (browser-safe; not used yet)
//
// Mirrors the lib/cache/redis.ts redisRestConfig() / redis() split: pure
// config helper that throws a clear message when env is missing, plus a
// lazy singleton on top.
export function supabaseConfig(): { url: string; serviceRoleKey: string } {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing Supabase credentials. Expected SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (Vercel Marketplace).",
    );
  }
  return { url, serviceRoleKey };
}

export function isSupabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && key);
}

export function supabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const { url, serviceRoleKey } = supabaseConfig();
  _admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}
