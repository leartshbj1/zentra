// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionOverview, type JourneyView } from './subscription-overview';
import { setAppLanguage } from './language';
import './languageTestPacks';

const day = 86_400, at = Math.floor(Date.UTC(2026, 9, 24, 12) / 1000);
const view = (change: Partial<JourneyView> = {}, used = 1_200, limit = 3_000): JourneyView => ({
  organizationId: 'org_a', organizationName: 'Menuiserie Exemple Sàrl', owner: true, canManage: true, name: 'Zentra Équipe', plan: 'team',
  monthlyChfCents: 7900, billingInterval: 'month', periodChfCents: 7900, status: 'active', renewalAt: at + 18 * day, trial: null,
  seats: { used: 3, limit: 5, reserved: 0 },
  products: [{ id: 'automation', name: 'Autopilote', active: true, detail: 'Automatismes configurés', until: null }],
  support: { active: true, used, limit, remaining: Math.max(0, limit - used), periodEnd: at + 8 * day, alert: null },
  change: null, canChange: true, portalAvailable: true, steps: [], onboardingComplete: true, ...change,
});
const text = (data: JourneyView) => renderToStaticMarkup(<SubscriptionOverview organizationId="org_a" initial={data} native request={async () => data} />).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

beforeEach(async () => { await setAppLanguage('fr'); });

describe('subscription overview', () => {
  it('shows the monthly price, collaborators and analyses in plain words, without VAT added', () => {
    const html = text(view());
    expect(html).toContain('Prix mensuel 79 CHF');
    expect(html).toContain('Collaborateurs 3 sur 5');
    expect(html).toContain('Analyses ce mois-ci');
    expect(html).toMatch(/1.200 sur 3.000/);
    expect(html).toContain('aucune TVA n’est ajoutée');
    expect(html).not.toContain('TVA comprise');
    expect(html).not.toContain('Il reste');
    expect(html).not.toContain('en pause');
  });

  it('shows the yearly price when the subscription is billed yearly', () => {
    const html = text(view({ billingInterval: 'year', periodChfCents: 79_000, monthlyChfCents: 6583 }));
    expect(html).toContain('Prix annuel 790 CHF');
    expect(html).toMatch(/soit 65.83 CHF par mois/);
    expect(html).not.toContain('Prix mensuel');
  });

  it('warns calmly from 80 % and pauses only Autopilote at 100 %', () => {
    const near = text(view({}, 2_400));
    expect(near).toContain('Il reste 600 analyses ce mois-ci. Autopilote continue jusqu’à la dernière.');
    expect(text(view({}, 2_399))).not.toContain('Il reste');
    const reached = text(view({}, 3_000));
    expect(reached).toMatch(/Autopilote en pause jusqu’au 1 novembre 2026\./);
    expect(reached).toContain('Le reste de Zentra continue normalement. Aucun supplément n’est facturé.');
    expect(text(view({ support: { active: true, used: 3_000, limit: 3_000, remaining: 0, periodEnd: null, alert: null } }))).toContain('Autopilote en pause jusqu’à la remise à zéro du compteur.');
  });

  it('keeps the trial wording without a price line', () => {
    const html = text(view({ status: 'trial', name: 'Essai gratuit Zentra', plan: null, monthlyChfCents: 0, billingInterval: null, periodChfCents: 0, trial: { active: true, endsAt: at + 9 * day, analyses: 500 } }, 120, 500));
    expect(html).toContain('Pendant 14 jours 0 CHF');
    expect(html).toContain('Sans carte bancaire');
    expect(html).not.toContain('TVA');
  });

  it('translates the new wording', async () => {
    await setAppLanguage('de');
    expect(text(view({}, 3_000))).toContain('Der Rest von Zentra funktioniert normal weiter.');
  });
});

const roots: { root: Root; host: HTMLDivElement }[] = [];
afterEach(async () => { for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); } vi.unstubAllGlobals(); });

describe('plan change on the web', () => {
  async function confirmChange(data: JourneyView, quote: Record<string, unknown>) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const calls: Record<string, unknown>[] = [];
    const request = vi.fn(async (body?: Record<string, unknown>) => { if (body) calls.push(body); return body?.action === 'quote' ? quote : data; });
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); roots.push({ root, host });
    await act(async () => root.render(<SubscriptionOverview organizationId="org_a" initial={data} request={request} />));
    const options = [...host.querySelectorAll('option')].map(option => option.textContent);
    await act(async () => (host.querySelector('.zentra-plan-change .zentra-sub-primary') as HTMLButtonElement).click());
    await act(async () => (host.querySelector('.zentra-sub-consent input') as HTMLInputElement).click());
    await act(async () => (host.querySelector('.zentra-plan-confirm .zentra-sub-primary') as HTMLButtonElement).click());
    return { options, calls, host };
  }
  const quote = { fingerprint: 'f', name: 'Zentra Pro', priceChfCents: 12900, effectiveAt: at + 18 * day, plan: 'pro' };

  it('offers Solo, Équipe and Pro without the Complet label and sends the server terms version', async () => {
    const { options, calls } = await confirmChange(view({ legalVersion: 'abonnement-2026-11-01' }), quote);
    expect(options).toEqual(['Solo · 49 CHF / mois · 1 personne(s)', 'Équipe · 79 CHF / mois · 5 personne(s)', 'Pro · 129 CHF / mois · 15 personne(s)']);
    expect(calls[0]).toEqual({ action: 'quote', plan: 'pro' });
    expect(calls[1]).toMatchObject({ action: 'change', plan: 'pro', fingerprint: 'f', acceptTerms: true, legalVersion: 'abonnement-2026-11-01' });
  });

  it('falls back to the current terms version, never the Complet 2026-09-23 terms', async () => {
    const { calls, host } = await confirmChange(view(), quote);
    expect(calls[1]).toMatchObject({ legalVersion: 'abonnement-2026-10-23' });
    expect(host.textContent).toContain('Autopilote inclus');
  });
});
