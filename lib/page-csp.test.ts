import { describe, expect, it } from 'vitest';
import { pageScriptPolicy, withoutCallerScriptPolicy } from './page-csp';
const request = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Request(`https://zentraapp.ch${path}`, { method, headers: { accept: 'text/html', ...headers } });

describe('HTML script execution policy', () => {
  it('keeps requests without policy hints unchanged', () => {
    const original = request('/compte');
    expect(withoutCallerScriptPolicy(original)).toBe(original);
  });
  it('strips policy hints before rendering without losing cookies or an API body', async () => {
    const original = new Request('https://zentraapp.ch/api/auth/connexion', { method: 'POST', headers: { 'x-nonce': 'forged', 'content-security-policy': 'forged', 'content-security-policy-report-only': 'forged', cookie: 'synthetic-session', 'content-type': 'application/json', origin: 'https://zentraapp.ch' }, body: '{"synthetic":true}' });
    const sanitized = withoutCallerScriptPolicy(original);
    expect(sanitized.url).toBe(original.url);
    expect(sanitized.method).toBe('POST');
    expect(sanitized.headers.get('cookie')).toBe('synthetic-session');
    expect(sanitized.headers.get('origin')).toBe('https://zentraapp.ch');
    for (const key of ['x-nonce', 'content-security-policy', 'content-security-policy-report-only']) expect(sanitized.headers.has(key)).toBe(false);
    expect(await sanitized.json()).toEqual({ synthetic: true });
  });
  it.each(['/', '/download', '/automation', '/complet', '/comparatif/bexio', '/connexion', '/compte', '/mot-de-passe/nouveau', '/invitation', '/support/espace', '/support/admin', '/paiement/succes', '/unknown-page'])('uses an independent nonce for %s', path => {
    const first = pageScriptPolicy(request(path))!, second = pageScriptPolicy(request(path))!;
    expect(first.headers.get('x-nonce')).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(first.headers.get('x-nonce')).not.toBe(second.headers.get('x-nonce'));
    expect(first.policy).toContain(`script-src 'self' 'nonce-${first.headers.get('x-nonce')}'`);
    expect(first.policy).toContain("script-src-attr 'none'");
    expect(first.policy.split('; ').find(item => item.startsWith('script-src '))).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(first.policy).toContain("frame-ancestors 'none'");
    expect(first.policy).toContain("object-src 'none'");
  });
  it('overwrites caller-provided CSP and nonce, preserving authentication headers', () => {
    const result = pageScriptPolicy(request('/compte', { 'x-nonce': 'forged', 'content-security-policy': "script-src 'nonce-forged'", 'content-security-policy-report-only': 'forged', cookie: 'synthetic-test-only' }))!;
    expect(result.headers.get('content-security-policy')).toBe(result.policy);
    expect(result.headers.get('content-security-policy-report-only')).toBeNull();
    expect(result.headers.get('x-nonce')).not.toBe('forged');
    expect(result.headers.get('cookie')).toBe('synthetic-test-only');
  });
  it.each(['/api', '/api/auth/connexion', '/api/support/oauth/zendesk', '/api/supplier-inbox'])('preserves the response policy owned by %s', path => {
    expect(pageScriptPolicy(request(path))).toBeNull();
  });
  it('handles HTML HEAD responses but leaves actions, RSC and asset delivery alone', () => {
    expect(pageScriptPolicy(request('/compte', {}, 'HEAD'))).not.toBeNull();
    expect(pageScriptPolicy(request('/compte', {}, 'POST'))).toBeNull();
    expect(pageScriptPolicy(request('/compte', { rsc: '1' }))).toBeNull();
    expect(pageScriptPolicy(request('/compte', { accept: 'text/x-component' }))).toBeNull();
    expect(pageScriptPolicy(request('/assets/main.js', { accept: '*/*' }))).toBeNull();
    expect(pageScriptPolicy(request('/compte', { accept: 'application/json' }))).toBeNull();
  });
});
