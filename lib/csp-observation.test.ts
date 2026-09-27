import { describe, expect, it } from 'vitest';
import { privatePageCspObservation } from './csp-observation';
const request = (path:string, headers:Record<string,string>={}, method='GET') => new Request(`https://zentraapp.ch${path}`,{method,headers:{accept:'text/html',...headers}});
describe('Private page script observation',()=>{
  it.each(['/connexion','/compte','/mot-de-passe/nouveau','/invitation','/support/espace','/support/admin','/paiement/succes'])('adds an independent nonce to %s',path=>{
    const first=privatePageCspObservation(request(path))!,second=privatePageCspObservation(request(path))!;
    expect(first.headers.get('x-nonce')).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(first.headers.get('x-nonce')).not.toBe(second.headers.get('x-nonce'));
    expect(first.policy).toContain(`'nonce-${first.headers.get('x-nonce')}'`);
    expect(first.policy).not.toContain('unsafe-inline');
  });
  it('overwrites caller-provided CSP and nonce without dropping other request headers',()=>{
    const observed=privatePageCspObservation(request('/connexion',{'x-nonce':'forged','content-security-policy':"script-src 'nonce-forged'",'content-security-policy-report-only':'forged',cookie:'synthetic-test-only'}))!;
    expect(observed.headers.get('content-security-policy')).toBeNull();
    expect(observed.headers.get('content-security-policy-report-only')).toBe(observed.policy);
    expect(observed.headers.get('x-nonce')).not.toBe('forged');
    expect(observed.headers.get('cookie')).toBe('synthetic-test-only');
  });
  it.each(['/','/download','/automation','/api','/api/auth/connexion','/assets/main.js'])('does not alter delivery for %s',path=>{
    expect(privatePageCspObservation(request(path))).toBeNull();
  });
  it('does not alter API mutations or RSC/fetch responses',()=>{
    expect(privatePageCspObservation(request('/compte',{},'POST'))).toBeNull();
    expect(privatePageCspObservation(request('/compte',{rsc:'1'}))).toBeNull();
    expect(privatePageCspObservation(request('/compte',{accept:'text/x-component'}))).toBeNull();
    expect(privatePageCspObservation(request('/compte',{accept:'application/json'}))).toBeNull();
  });
});
