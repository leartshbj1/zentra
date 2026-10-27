import { useEffect, useId, useRef, useState } from 'react';
import { Bell, Check, ChevronRight } from 'lucide-react';
import { isFresh, FRESH_SECONDS, useAutopilotSeen } from './autopilotSeen';
import { sinceShort, type TodayEntry } from './AutopilotToday';
import type { JournalEntry } from './autopilotJournal';

/*
 * Notifications: what arrived and what Zentra did, from the topbar.
 * A small dot on the bell while something new was never opened; no counter.
 * A row opens the item in Autopilote "Aujourd'hui". Presentation only.
 */

type Copy = Readonly<Record<string, readonly [string, string, string, string]>>;
const copy: Copy = {
  title: ['Notifications', 'Mitteilungen', 'Notifiche', 'Notifications'],
  bell: ['Notifications', 'Mitteilungen', 'Notifiche', 'Notifications'],
  bellUnread: ['Notifications, {n} nouvelle(s)', 'Mitteilungen, {n} neu', 'Notifiche, {n} nuova/e', 'Notifications, {n} new'],
  arrived: ['Arrivé', 'Eingegangen', 'Arrivato', 'Arrived'],
  did: ['Fait par Zentra', 'Von Zentra erledigt', 'Fatto da Zentra', 'Done by Zentra'],
  readAll: ['Tout marquer comme lu', 'Alle als gelesen markieren', 'Segna tutto come letto', 'Mark all as read'],
  empty: ['Rien de nouveau. Autopilote vous prévient dès qu’un e-mail, un paiement ou une demande arrive.', 'Nichts Neues. Autopilote meldet sich, sobald eine E-Mail, eine Zahlung oder eine Anfrage eintrifft.', 'Niente di nuovo. Autopilote ti avvisa appena arriva un’e-mail, un pagamento o una richiesta.', 'Nothing new. Autopilote tells you as soon as an e-mail, a payment or a request arrives.'],
  history: ['Voir toute l’activité', 'Alle Aktivitäten ansehen', 'Vedi tutta l’attività', 'See all activity'],
  fresh: ['Nouveau', 'Neu', 'Nuovo', 'New'],
};

const ARRIVALS = 20, DONE = 8;

export function AutopilotNotifications({ language, organizationId, entries, journal, autoLabel, onOpen, onOpenHistory }: {
  language: string; organizationId: string;
  /** The items of "Aujourd'hui"; only those that arrived from outside are listed. */
  entries: readonly TodayEntry[];
  journal: readonly JournalEntry[];
  /** The suffix Autopilote adds to an action it validated alone. */
  autoLabel: string;
  onOpen: (id: string) => void; onOpenHistory: () => void;
}) {
  const index = Math.max(0, ['fr', 'de', 'it', 'en'].indexOf(language));
  const say = (key: string, n?: number) => copy[key][index].replace('{n}', String(n ?? ''));
  const { seen, markSeen } = useAutopilotSeen(organizationId);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const now = Date.now();
  // Recent arrivals only: what is older still waits in "Aujourd'hui".
  const arrivals = entries.filter(entry => entry.at && now / 1000 - entry.at < FRESH_SECONDS).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, ARRIVALS);
  // Done by Zentra in the last days; what it validated alone is news, what you clicked is not.
  const done = journal.filter(entry => entry.ok !== false && !entry.undoneAt && now - Date.parse(entry.at) < FRESH_SECONDS * 1000).slice(0, DONE);
  const doneId = (entry: JournalEntry) => `done:${entry.id}`;
  const alone = (entry: JournalEntry) => !!autoLabel && entry.actionLabel.endsWith(autoLabel);
  const unreadArrivals = arrivals.filter(entry => isFresh(entry.id, entry.at, seen, now));
  const unreadDone = done.filter(entry => alone(entry) && !seen[doneId(entry)]);
  const unread = unreadArrivals.length + unreadDone.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.autopilot-bell')?.focus(); } };
    const onDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown); };
  }, [open]);
  // Seeing what Zentra did is reading it; arrivals stay new until opened.
  useEffect(() => { if (open && unreadDone.length) markSeen(unreadDone.map(doneId)); }, [open]);

  const time = (seconds: number) => sinceShort(seconds, language, now);
  const pick = (id: string) => { setOpen(false); onOpen(id); };

  return <div className="autopilot-notices" ref={root}>
    <button type="button" className="autopilot-bell" aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog"
      aria-label={unread ? say('bellUnread', unread) : say('bell')} title={say('bell')} onClick={() => setOpen(value => !value)}>
      <Bell size={18} aria-hidden="true" />
      {unread ? <span className="autopilot-bell__dot" aria-hidden="true" /> : null}
    </button>
    {open && <div className="autopilot-notices__panel" id={panelId} role="dialog" aria-label={say('title')}>
      <header className="autopilot-notices__head">
        <h2>{say('title')}</h2>
        {unreadArrivals.length ? <button type="button" className="autopilot-notices__text" onClick={() => markSeen(unreadArrivals.map(entry => entry.id))}>{say('readAll')}</button> : null}
      </header>
      <div className="autopilot-notices__scroll">
        {!arrivals.length && !done.length ? <p className="autopilot-notices__empty">{say('empty')}</p> : null}
        {arrivals.length ? <section aria-label={say('arrived')}>
          <h3>{say('arrived')}</h3>
          <ul>{arrivals.map(entry => {
            const fresh = isFresh(entry.id, entry.at, seen, now);
            return <li key={entry.id}><button type="button" data-unread={fresh || undefined} onClick={() => pick(entry.id)}>
              <span className="autopilot-notices__mark" aria-hidden="true" />
              <span className="autopilot-notices__text-block">
                <small>{[fresh ? say('fresh') : '', entry.kind, entry.origin].filter(Boolean).join(' · ')}</small>
                <strong>{entry.title}</strong>
                {entry.sub && entry.sub !== entry.title ? <span>{entry.sub}</span> : null}
              </span>
              <time dateTime={new Date((entry.at ?? 0) * 1000).toISOString()}>{time(entry.at ?? 0)}</time>
            </button></li>;
          })}</ul>
        </section> : null}
        {done.length ? <section aria-label={say('did')}>
          <h3>{say('did')}</h3>
          <ul>{done.map(entry => <li key={entry.id}><button type="button" data-unread={unreadDone.includes(entry) || undefined} onClick={() => { setOpen(false); onOpenHistory(); }}>
            <span className="autopilot-notices__check" aria-hidden="true"><Check size={13} strokeWidth={2.6} /></span>
            <span className="autopilot-notices__text-block">
              <small>{entry.actionLabel}</small>
              <strong>{entry.title}</strong>
            </span>
            <time dateTime={entry.at}>{time(Date.parse(entry.at) / 1000)}</time>
          </button></li>)}</ul>
        </section> : null}
      </div>
      <footer className="autopilot-notices__foot">
        <button type="button" className="autopilot-notices__text" onClick={() => { setOpen(false); onOpenHistory(); }}>{say('history')}<ChevronRight size={15} aria-hidden="true" /></button>
      </footer>
    </div>}
  </div>;
}
