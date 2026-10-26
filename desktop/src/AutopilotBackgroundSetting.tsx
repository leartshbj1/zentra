import { useEffect, useRef, useState } from 'react';
import { backgroundApi, backgroundSchedule, type BackgroundStatus } from './autopilotBackground';
import { followUpEntries } from './autopilotFollowUps';
import { desktopApi } from './bridge';
import { getAppLocale, t, useAppLanguage } from './language';
import type { Workspace } from './types';
import { Button } from './ui';
import { errorMessage } from './utils';

// Last known switch position on this device, so the daily renewal runs without asking the server first.
const FLAG = 'zentra.autopilot-background.v1';
type Flag = { enabled: boolean; renewedOn?: string; scheduledAt?: number };
function readFlag(): Flag { try { return JSON.parse(localStorage.getItem(FLAG) ?? '') as Flag; } catch { return { enabled: false }; } }
function writeFlag(next: Flag) { try { localStorage.setItem(FLAG, JSON.stringify(next)); } catch { /* the next start asks the server again */ } }
const today = () => new Date().toISOString().slice(0, 10);

function stateLine(status: BackgroundStatus): string {
  if (!status.enabled) return t('Désactivé : Autopilote travaille seulement quand Zentra est ouvert.');
  if (status.lastState === 'renewal_needed') return t('À renouveler : ouvrez Zentra sur un ordinateur de l’entreprise.');
  if (status.lastState === 'paused') return t('En pause : vérifiez l’abonnement.');
  if (status.lastState === 'unavailable') return t('Indisponible pour le moment. Autopilote réessaie tout seul.');
  if (!status.lastRunAt) return t('Actif · premier passage dans quelques minutes');
  const time = new Intl.DateTimeFormat(getAppLocale(), { hour: '2-digit', minute: '2-digit' }).format(status.lastRunAt * 1000);
  return t('Actif · dernier passage à {time}', { time });
}

/** « Continuer quand mes ordinateurs sont éteints » : titulaire et administrateurs ; les autres voient l'état. */
export function AutopilotBackgroundSetting({ canManage }: { canManage: boolean }) {
  useAppLanguage();
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    backgroundApi.call('status').then(value => { if (live) { setStatus(value); writeFlag({ ...readFlag(), enabled: value.enabled }); } })
      .catch(reason => { if (live) setMessage(errorMessage(reason, t('L’état n’a pas pu être lu.'))); });
    return () => { live = false; };
  }, []);
  async function run(operation: 'enable' | 'disable') {
    setBusy(true); setMessage('');
    try {
      const next = await backgroundApi.call(operation);
      setStatus(next);
      writeFlag({ enabled: next.enabled, renewedOn: next.enabled ? today() : undefined });
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le réglage n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }
  const enabled = status?.enabled ?? false;
  return <section className="autopilot-background" aria-labelledby="autopilot-background-title">
    <label className="reminder-charges__interest">
      <input type="checkbox" role="switch" aria-checked={enabled} checked={enabled} disabled={!canManage || busy || !status}
        onChange={event => void run(event.target.checked ? 'enable' : 'disable')} />
      <span><strong id="autopilot-background-title">{t('Continuer quand mes ordinateurs sont éteints')}</strong>
        <small>{t('Autopilote lit vos mails et prépare vos devis et vos rappels même quand vos ordinateurs sont éteints. Il vous prévient sur votre téléphone. Rien n’est créé ni envoyé sans votre clic.')}</small></span>
    </label>
    {status ? <p className="autopilot-background__state" role="status">{stateLine(status)}{status.enabled && status.waiting ? ' · ' + t('{n} notification(s) en attente', { n: status.waiting }) : ''}</p> : null}
    {status?.enabled && status.lastState === 'renewal_needed' && canManage
      ? <Button variant="secondary" size="small" disabled={busy} onClick={() => void run('enable')}>{t('Reprendre sur cet ordinateur')}</Button> : null}
    {!canManage ? <p className="autopilot-background__note">{t('Le titulaire ou un administrateur peut changer ce réglage.')}</p> : null}
    {message ? <p className="autopilot-background__note" role="status">{message}</p> : null}
  </section>;
}

/**
 * While the setting is on: renew once a day (the server recreates its session at
 * most daily) and send the schedule at start, then after changes, at most every
 * five minutes. Nothing runs when the switch is off on this device.
 */
export function useAutopilotBackgroundRunner(workspace: Workspace, organizationId: string | null, vat: Readonly<{ from: string; to: string }> | null, readOnly: boolean) {
  const latest = useRef({ workspace, organizationId, vat });
  latest.current = { workspace, organizationId, vat };
  const timer = useRef<number | null>(null);
  // An app left open overnight still renews on the new day.
  const [day, setDay] = useState(today());
  useEffect(() => { const id = window.setInterval(() => setDay(today()), 3_600_000); return () => window.clearInterval(id); }, []);
  useEffect(() => {
    if (readOnly || !readFlag().enabled) return;
    const send = async () => {
      timer.current = null;
      const flag = readFlag();
      if (!flag.enabled) return;
      try {
        if (flag.renewedOn !== today()) {
          const status = await backgroundApi.call('enable');
          writeFlag({ ...readFlag(), enabled: status.enabled, renewedOn: status.enabled ? today() : undefined });
          if (!status.enabled) return;
        }
        const { workspace: current, organizationId: org, vat: period } = latest.current;
        const reminders = await desktopApi.listReminders().catch(() => []);
        const clientNames = Object.fromEntries(current.clients.map(client => [client.id, client.company || client.name]));
        const items = backgroundSchedule({ reminders, quotes: current.quotes, clientNames, followUps: org ? followUpEntries(org) : {},
          supplierInvoices: current.supplierInvoices, vat: period, today: today() });
        await backgroundApi.schedule(items);
        writeFlag({ ...readFlag(), scheduledAt: Date.now() });
      } catch { /* retried on the next change or the next start */ }
    };
    const wait = Math.max(0, (readFlag().scheduledAt ?? 0) + 5 * 60_000 - Date.now());
    if (timer.current === null) timer.current = window.setTimeout(() => void send(), wait);
    return () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  }, [workspace.invoices, workspace.quotes, workspace.supplierInvoices, vat?.from, readOnly, day]);
}
