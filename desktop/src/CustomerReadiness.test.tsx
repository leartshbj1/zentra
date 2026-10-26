// @vitest-environment jsdom
import './languageTestPacks';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CustomerReadiness } from './TerrainSettings';
import { DEFAULT_ENGAGEMENT, type SmsSettings } from './customerEngagement';
import type { Workspace } from './types';

let root: Root, host: HTMLDivElement;
const sms = (enabled: boolean, secretPresent: boolean): SmsSettings => ({ enabled, secretPresent, provider: 'aspsms', sender: 'Atelier', account: 'key', endpoint: null, appointmentRemindersAuto: false });
const workspace = (engagement = DEFAULT_ENGAGEMENT) => ({ customerEngagement: engagement }) as unknown as Workspace;
const lines = () => Array.from(host.querySelectorAll('li')).map(li => [li.querySelector('strong')?.textContent, li.classList.contains('is-ready')]);
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('lists the four client settings that are still missing', async () => {
  await act(async () => root.render(<CustomerReadiness workspace={workspace()} sms={null} />));
  expect(host.querySelector('h3')?.textContent).toBe('À régler');
  expect(host.textContent).toContain('0 sur 4 prêts');
  expect(lines()).toEqual([['Compte SMS', false], ['Lien d’avis Google', false], ['Horaires de rendez-vous en ligne', false], ['Pourcentage d’acompte', false]]);
});

it('counts a setting as ready only when it can really be used', async () => {
  const engagement = { ...DEFAULT_ENGAGEMENT, reviewUrl: 'https://g.page/r/test', bookingEnabled: true, bookingDays: 0, depositPercentBp: 3000 };
  await act(async () => root.render(<CustomerReadiness workspace={workspace(engagement)} sms={sms(true, false)} />));
  // SMS enabled without its key, and booking switched on without any day, stay to set.
  expect(lines()).toEqual([['Compte SMS', false], ['Lien d’avis Google', true], ['Horaires de rendez-vous en ligne', false], ['Pourcentage d’acompte', true]]);
  await act(async () => root.render(<CustomerReadiness workspace={workspace({ ...engagement, bookingDays: 31 })} sms={sms(true, true)} />));
  expect(host.querySelector('h3')?.textContent).toBe('Tout est prêt');
  expect(host.textContent).toContain('4 sur 4 prêts');
});
