import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION, hasCurrentLegalAcceptance } from './legal';
import { readAuthCredentials } from './supabase-auth-http';

describe('explicit legal acceptance', () => {
  it.each([{}, {acceptTerms:false,legalVersion:LEGAL_VERSION}, {acceptTerms:'true',legalVersion:LEGAL_VERSION}, {acceptTerms:true,legalVersion:'2025-01-01'}])('rejects absent, coerced or stale acceptance: %j', body => {
    expect(hasCurrentLegalAcceptance(body)).toBe(false);
  });
  it('accepts only the explicit current version', () => {
    expect(hasCurrentLegalAcceptance({acceptTerms:true, legalVersion:LEGAL_VERSION})).toBe(true);
  });
  it('enforces acceptance before creating a Supabase account without changing login behavior', async () => {
    const credentials={email:'test@example.ch',password:'a-long-test-password'};
    const request=(extra={})=>new Request('https://zentraapp.ch/api/auth/inscription',{method:'POST',body:JSON.stringify({...credentials,...extra})});
    await expect(readAuthCredentials(request(),{requireLegalAcceptance:true})).rejects.toThrow('conditions Zentra');
    await expect(readAuthCredentials(request({acceptTerms:true,legalVersion:LEGAL_VERSION}),{requireLegalAcceptance:true})).resolves.toMatchObject(credentials);
    await expect(readAuthCredentials(request())).resolves.toMatchObject(credentials);
  });
});
