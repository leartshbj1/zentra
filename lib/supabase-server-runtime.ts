import { env } from 'cloudflare:workers';
import { createSupabaseServerClient } from './supabase-server';

type SupabaseServerBindings = {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

const bindings = env as unknown as SupabaseServerBindings;

function runtimeValue(name: keyof SupabaseServerBindings): string {
  const bound = bindings[name];
  if (typeof bound === 'string' && bound.trim()) return bound.trim();
  return process.env[name]?.trim() ?? '';
}

let cached: ReturnType<typeof createSupabaseServerClient> | null = null;
let cachedIdentity = '';

/**
 * Server-only persistence client. SUPABASE_SECRET_KEY is preferred so the old
 * Ohio service-role value can remain available temporarily for rollback.
 */
export function supabaseServerClient() {
  const url = runtimeValue('SUPABASE_URL');
  const secretKey =
    runtimeValue('SUPABASE_SECRET_KEY') ||
    runtimeValue('SUPABASE_SERVICE_ROLE_KEY');
  // The identity is a digest-free cache discriminator and is never exported or
  // logged. It only lives inside the server isolate.
  const identity = `${url}\u0000${secretKey}`;
  if (!cached || cachedIdentity !== identity) {
    cached = createSupabaseServerClient({ url, secretKey });
    cachedIdentity = identity;
  }
  return cached;
}
