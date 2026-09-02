import { env } from 'cloudflare:workers';
import {
  createSupabaseAuthClient,
  validateSupabaseAuthConfiguration,
} from './supabase-auth';

type SupabaseAuthBindings = {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  PUBLIC_SITE_URL?: string;
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
  const configured = readRuntimeValue('PUBLIC_SITE_URL');
  let url: URL;
  try {
    url = new URL(configured || request.url);
  } catch {
    throw new Error('PUBLIC_SITE_URL est invalide.');
  }
  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1';
  if (
    (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    (Boolean(configured) && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error('PUBLIC_SITE_URL doit être une origine HTTPS sûre.');
  }
  if (!configured && !isLocal) {
    throw new Error('PUBLIC_SITE_URL est requis hors développement local.');
  }
  return url.origin;
}

function readRuntimeValue(name: keyof SupabaseAuthBindings): string {
  const bound = bindings[name];
  if (typeof bound === 'string' && bound.trim()) return bound.trim();
  return process.env[name]?.trim() ?? '';
}
