// @vitest-environment jsdom
import './languageTestPacks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { profileFromOrganization, slugify, StorefrontSettings, storefrontApi, type StorefrontPage } from './StorefrontSettings';
import type { Organization } from './types';

let root: Root, host: HTMLDivElement;
const organization: Organization = {
  legalName: 'Sanitaire Rochat & Fils', legalForm: 'sarl', contactName: 'Marc Rochat', email: 'info@rochat.example', phone: '022 555 01 01',
  website: 'rochat.example', uidNumber: '', vatNumber: '', vatRegistered: false,
  address: { street: 'Rue de Carouge', buildingNumber: '48', postalCode: '1205', city: 'Genève', canton: 'GE', country: 'CH' },
};
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!;
const type = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(400); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try { localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('folds a company name like the server and starts from the company settings', () => {
  expect(slugify('Sanitaire Rochat & Fils')).toBe('sanitaire-rochat-et-fils');
  expect(profileFromOrganization(organization)).toMatchObject({ companyName: 'Sanitaire Rochat & Fils', street: 'Rue de Carouge 48', postalCode: '1205',
    locality: 'Genève', website: 'https://rochat.example', quoteRequests: true, contactRequests: true });
});

it('offers free addresses when the wanted one is taken, then creates the page on a free one', async () => {
  vi.spyOn(storefrontApi, 'read').mockResolvedValue({ organizationId: 'org_1', page: null });
  const check = vi.spyOn(storefrontApi, 'check').mockImplementation(async slug => slug === 'sanitaire-rochat-et-fils'
    ? { slug, state: 'taken', url: null, suggestions: ['sanitaire-rochat-et-fils-geneve', 'sanitaire-rochat-et-fils-ch'] }
    : { slug, state: 'available', url: `https://${slug}.zentraapp.ch/`, suggestions: [] });
  const saved: StorefrontPage = { slug: 'sanitaire-rochat-et-fils-geneve', url: 'https://sanitaire-rochat-et-fils-geneve.zentraapp.ch/', published: true,
    profile: profileFromOrganization(organization), updatedAt: 1 };
  const save = vi.spyOn(storefrontApi, 'save').mockResolvedValue({ organizationId: 'org_1', page: saved });
  vi.spyOn(storefrontApi, 'requests').mockResolvedValue({ organizationId: 'org_1', items: [], nextCursor: null });
  await act(async () => root.render(<StorefrontSettings organization={organization} disabled={false} />));
  await settle();
  expect(check).toHaveBeenLastCalledWith('sanitaire-rochat-et-fils', 'Genève', 'GE');
  expect(host.textContent).toContain('Déjà prise par une autre entreprise.');
  expect(button('Créer ma page').disabled).toBe(true);
  await act(async () => button('sanitaire-rochat-et-fils-geneve.zentraapp.ch').click());
  await settle();
  expect(host.textContent).toContain('Libre : cette adresse peut être la vôtre.');
  await act(async () => button('Créer ma page').click());
  expect(save).toHaveBeenCalledWith('sanitaire-rochat-et-fils-geneve', true, expect.objectContaining({ companyName: 'Sanitaire Rochat & Fils', services: [] }));
  expect(host.textContent).toContain('Page publiée.');
  expect(host.querySelector('a[href="https://sanitaire-rochat-et-fils-geneve.zentraapp.ch/"]')).not.toBeNull();
  expect(localStorage.getItem('zentra.storefront.active.v1')).toBe('1');
});

it('shows received requests newest first, with reply links', async () => {
  const page: StorefrontPage = { slug: 'rochat', url: 'https://rochat.zentraapp.ch/', published: true, profile: profileFromOrganization(organization), updatedAt: 1 };
  vi.spyOn(storefrontApi, 'read').mockResolvedValue({ organizationId: 'org_1', page });
  vi.spyOn(storefrontApi, 'check').mockImplementation(async slug => ({ slug, state: 'yours', url: `https://${slug}.zentraapp.ch/`, suggestions: [] }));
  vi.spyOn(storefrontApi, 'requests').mockResolvedValue({ organizationId: 'org_1', nextCursor: 'sr1_2', items: [
    { requestId: 'sr000000000001-a', kind: 'contact', contactName: 'Paul Favre', email: '', phone: '079 123 45 67', locality: '', message: 'Ouvert samedi ?', at: 1_790_000_000 },
    { requestId: 'sr000000000002-b', kind: 'quote', contactName: 'Marie Rochat', email: 'marie@example.test', phone: '', locality: '1205 Genève', message: 'Une douche à l’italienne.', at: 1_790_000_100 },
  ] });
  await act(async () => root.render(<StorefrontSettings organization={organization} disabled={false} />));
  await settle();
  const names = [...host.querySelectorAll('.storefront-settings__requests strong')].map(item => item.textContent);
  expect(names).toEqual(['Marie Rochat', 'Paul Favre']);
  expect(host.querySelector('a[href^="mailto:marie@example.test"]')).not.toBeNull();
  expect(host.querySelector('a[href="tel:0791234567"]')).not.toBeNull();
  expect(host.textContent).toContain('C’est l’adresse actuelle de votre page.');
  expect(button('Enregistrer la page').disabled).toBe(false);
});

it('keeps everything locked in read-only mode', async () => {
  vi.spyOn(storefrontApi, 'read').mockResolvedValue({ organizationId: 'org_1', page: null });
  const check = vi.spyOn(storefrontApi, 'check');
  await act(async () => root.render(<StorefrontSettings organization={organization} disabled />));
  await settle();
  expect(check).not.toHaveBeenCalled();
  expect([...host.querySelectorAll('input, textarea')].every(input => (input as HTMLInputElement).disabled)).toBe(true);
  expect(button('Créer ma page').disabled).toBe(true);
});
