import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { browserSellerCopy, buildBrowserSellerProfile, UsSellerProfileDetails, UsSellerProfilePanel, type BrowserSellerDraft, type UsSellerProfilePanelProps } from '../../components/account/us-seller-profile-panel';
import { SITE_LANGUAGES } from '../site-language';
import { validateUsSellerProfileWrite, type UsSellerProfileState } from './seller-profile';

const organizationId = 'fictitious-us-seller-scope';
const updatedBy = 'fictitious-private-auth-user';
const draft: BrowserSellerDraft = { displayName: 'Fictitious Seller', contactEmail: 'seller@example.test', contactPhone: '+1 202 555 0100' };
const configured: UsSellerProfileState = { status: 'configured', organizationId, revision: 17, profile: draft, updatedBy, updatedAt: '2026-10-08T10:00:00.123456Z' };
const unconfigured: UsSellerProfileState = { status: 'unconfigured', organizationId, revision: 0 };
const textMarkup = (text: string) => renderToStaticMarkup(createElement(Fragment, null, text));
const panelProps: UsSellerProfilePanelProps = { organizationId, expectedUserId: updatedBy, role: 'owner', language: 'en', blocked: false, writeLocked: false, accessEpoch: 0, currentAccessEpoch: () => 0, otherBusy: () => false, otherPending: () => false, onBusyChange: () => {}, onPendingChange: () => {}, onAccessDenied: () => {} };

describe('US seller browser draft validation', () => {
  it('trims the three public fields and produces a profile accepted by the server contract', () => {
    const profile = buildBrowserSellerProfile({ displayName: '  Fictitious Seller  ', contactEmail: '  seller@example.test  ', contactPhone: '  +1 202 555 0100  ' });
    expect(profile).toEqual(draft);
    expect(validateUsSellerProfileWrite({ expectedRevision: 17, requestId: '8c7e0b5f-4a52-4f49-9e92-4a8adb2256b1', profile }).profile).toEqual(draft);
  });

  it.each(['', '   ', '\u00a0  \u00a0'])('omits blank optional contacts instead of sending null or an empty value (%j)', value => {
    const profile = buildBrowserSellerProfile({ ...draft, contactEmail: value, contactPhone: value });
    expect(profile).toEqual({ displayName: draft.displayName });
    expect(Object.hasOwn(profile, 'contactEmail')).toBe(false);
    expect(Object.hasOwn(profile, 'contactPhone')).toBe(false);
  });

  it.each(['', '   ', '\u00a0'])('requires an explicit seller name (%j)', displayName => {
    expect(() => buildBrowserSellerProfile({ ...draft, displayName })).toThrow();
  });

  it('counts UTF16 units for the seller name without truncating or normalizing its content', () => {
    const displayName = '\ud83d\ude80'.repeat(128);
    expect(displayName.length).toBe(256);
    expect(buildBrowserSellerProfile({ ...draft, displayName }).displayName).toBe(displayName);
    expect(() => buildBrowserSellerProfile({ ...draft, displayName: `${displayName}a` })).toThrow();
    expect(buildBrowserSellerProfile({ ...draft, displayName: 'Cafe\u0301 & Company' }).displayName).toBe('Cafe\u0301 & Company');
  });

  it('enforces raw name length before trimming surrounding spaces', () => {
    expect(buildBrowserSellerProfile({ ...draft, displayName: 'a'.repeat(256) }).displayName).toHaveLength(256);
    expect(() => buildBrowserSellerProfile({ ...draft, displayName: ` ${'a'.repeat(256)} ` })).toThrow();
  });

  it('enforces raw email length at 254 UTF16 units before trimming', () => {
    const suffix = '@example.test';
    const contactEmail = `${'a'.repeat(254 - suffix.length)}${suffix}`;
    expect(buildBrowserSellerProfile({ ...draft, contactEmail }).contactEmail).toBe(contactEmail);
    expect(() => buildBrowserSellerProfile({ ...draft, contactEmail: ` ${contactEmail} ` })).toThrow();
    expect(() => buildBrowserSellerProfile({ ...draft, contactEmail: `a${contactEmail}` })).toThrow();
  });

  it('enforces raw phone length at 80 UTF16 units without inventing a phone normalization rule', () => {
    const contactPhone = '\ud83d\udcde'.repeat(40);
    expect(buildBrowserSellerProfile({ ...draft, contactPhone }).contactPhone).toBe(contactPhone);
    expect(() => buildBrowserSellerProfile({ ...draft, contactPhone: ` ${contactPhone} ` })).toThrow();
    expect(() => buildBrowserSellerProfile({ ...draft, contactPhone: `${contactPhone}a` })).toThrow();
  });

  it.each(['not-email', '@example.test', 'seller@', 'seller@example', 'seller @example.test', '<seller>@example.test', 'seller@example.test extra', 'one@example.test,two@example.test'])('rejects invalid contact email %j before a write', contactEmail => {
    expect(() => buildBrowserSellerProfile({ ...draft, contactEmail })).toThrow();
  });

  it.each(['displayName', 'contactEmail', 'contactPhone'] as const)('rejects control characters in %s even when trimming could hide them', field => {
    for (const control of ['\u0000', '\t', '\n', '\r', '\u007f']) {
      expect(() => buildBrowserSellerProfile({ ...draft, [field]: `${control}${draft[field]}${control}` }), JSON.stringify({ field, control })).toThrow();
      expect(() => buildBrowserSellerProfile({ ...draft, [field]: control }), JSON.stringify({ field, control, blank: true })).toThrow();
    }
  });

  it('copies only the public profile and does not retain form references or accept ownership claims', () => {
    const input = { ...draft, organizationId: 'other-tenant', updatedBy: 'other-user', authority_json: 'private-authority', taxConfiguration: { status: 'configured' } };
    const profile = buildBrowserSellerProfile(input);
    expect(Object.keys(profile).sort()).toEqual(['displayName', 'contactEmail', 'contactPhone'].sort());
    input.displayName = 'Changed unsaved draft';
    expect(profile.displayName).toBe(draft.displayName);
    expect(JSON.stringify(profile)).not.toMatch(/other-tenant|other-user|private-authority|taxConfiguration/);
  });
});

describe('US seller public read presentation', () => {
  it('provides the same nonempty copy keys in all four supported languages', () => {
    const keys = ['sellerTitle', 'sellerEmpty', 'displayName', 'contactEmail', 'contactPhone', 'revision', 'nonVerified'];
    expect([...SITE_LANGUAGES].sort()).toEqual(['de', 'en', 'fr', 'it']);
    for (const language of SITE_LANGUAGES) {
      const copy = browserSellerCopy[language];
      expect(Object.keys(copy).sort()).toEqual(Object.keys(browserSellerCopy.en).sort());
      expect(keys.every(key => Object.hasOwn(copy, key))).toBe(true);
      expect(Object.values(copy).every(value => typeof value === 'string' && value.trim().length > 0)).toBe(true);
    }
  });

  it.each(SITE_LANGUAGES)('renders %s unconfigured state without inventing a seller or making a request', language => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(createElement(UsSellerProfileDetails, { state: unconfigured, language }));
      expect(html).toContain(textMarkup(browserSellerCopy[language].sellerEmpty));
      expect(html).not.toContain(draft.displayName);
      expect(html).not.toContain(draft.contactEmail);
      expect(html).not.toContain(organizationId);
      expect(html).not.toMatch(/<form|<input|<button|CHF|authority_json|subscription_id/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });

  it.each(SITE_LANGUAGES)('renders only the three saved public fields and the distinct seller revision in %s', language => {
    const copy = browserSellerCopy[language];
    const html = renderToStaticMarkup(createElement(UsSellerProfileDetails, { state: configured, language }));
    for (const value of [draft.displayName, draft.contactEmail, draft.contactPhone, copy.displayName, copy.contactEmail, copy.contactPhone, copy.revision]) expect(html).toContain(textMarkup(value));
    expect(html).toMatch(/\b17\b/);
    expect(html).toContain('<dl');
    expect(html).not.toContain(organizationId);
    expect(html).not.toContain(updatedBy);
    expect(html).not.toMatch(/<form|<input|<button|CHF|authority_json|subscription_id/);
  });

  it('does not infer an optional contact from organization or audit metadata', () => {
    const state: UsSellerProfileState = { ...configured, profile: { displayName: draft.displayName } };
    const html = renderToStaticMarkup(createElement(UsSellerProfileDetails, { state, language: 'en' }));
    expect(html).toContain(draft.displayName);
    expect(html).not.toContain(draft.contactEmail);
    expect(html).not.toContain(draft.contactPhone);
    expect(html).not.toContain(updatedBy);
    expect(html).not.toContain(organizationId);
  });

  it('escapes stored public text and never serializes additional private state into markup', () => {
    const profile = { displayName: '<script>seller()</script> & "Company"', contactEmail: 'accounts&billing@example.test', contactPhone: '<script>phone()</script>' };
    const state = { ...configured, profile, authority_json: 'private-authority-canary', evidence: 'private-evidence-canary' };
    const html = renderToStaticMarkup(createElement(UsSellerProfileDetails, { state, language: 'en' }));
    for (const value of Object.values(profile)) expect(html).toContain(textMarkup(value));
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/private-authority-canary|private-evidence-canary|fictitious-private-auth-user|fictitious-us-seller-scope/);
  });

  it.each(SITE_LANGUAGES)('renders the initial %s panel with the verification limit and no SSR read or autosave', language => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const copy = browserSellerCopy[language];
      const html = renderToStaticMarkup(createElement(UsSellerProfilePanel, { ...panelProps, language }));
      for (const value of [copy.sellerTitle, copy.nonVerified, copy.loading]) expect(html).toContain(textMarkup(value));
      expect(html).not.toContain(draft.displayName);
      expect(html).not.toContain(organizationId);
      expect(html).not.toContain(updatedBy);
      expect(html).not.toMatch(/<form|<input|authority_json|subscription_id/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });

  it.each(['owner', 'admin', 'accountant', 'member', 'read_only'] as const)('explains owner-only seller editing for initial role %s', role => {
    const html = renderToStaticMarkup(createElement(UsSellerProfilePanel, { ...panelProps, role }));
    if (role === 'owner') expect(html).not.toContain(textMarkup(browserSellerCopy.en.ownerOnly));
    else expect(html).toContain(textMarkup(browserSellerCopy.en.ownerOnly));
  });
});
