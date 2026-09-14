import { env } from 'cloudflare:workers';
import { trustedSiteRequestOrigin } from './site-origins';
import {
  createSupabaseAuthClient,
  validateSupabaseAuthConfiguration,
} from './supabase-auth';

type SupabaseAuthBindings = {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  PUBLIC_SITE_URL?: string;
  SITE_ORIGIN_ALIASES?: string;
};

const bindings = env as unknown as SupabaseAuthBindings;

export function supabaseAuthConfiguration() {
  return validateSupabaseAuthConfiguration({
    url: readRuntimeValue('SUPABASE_URL'),
    publishableKey: readRuntimeValue('SUPABASE_PUBLISHABLE_KEY'),
  });
}

export function optionalSupabaseAuthClient() {
  try {
    return createSupabaseAuthClient(supabaseAuthConfiguration());
  } catch {
    return null;
  }
}

export function supabaseAuthClient() {
  return createSupabaseAuthClient(supabaseAuthConfiguration());
}

export function supabaseAuthSiteOrigin(request: Request) {
  return trustedSiteRequestOrigin(
    request,
    readRuntimeValue('PUBLIC_SITE_URL'),
    readRuntimeValue('SITE_ORIGIN_ALIASES'),
  );
}

function readRuntimeValue(name: keyof SupabaseAuthBindings): string {
  const bound = bindings[name];
  if (typeof bound === 'string' && bound.trim()) return bound.trim();
  return process.env[name]?.trim() ?? '';
}
