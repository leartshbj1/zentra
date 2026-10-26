import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Settings2 } from 'lucide-react';
import { t } from './language';
import { autopilotCopy } from './autopilotPresentation';
import { autopilotKind } from './autopilotKinds';
import { doneToday, type JournalEntry } from './autopilotJournal';
import { normalizeAutopilotReviewPage, type AutopilotReviewItem, type AutopilotRequestKey } from './autopilotReview';
import { autopilotRequestStage } from './autopilotQuote';
import { AutopilotReviews, autopilotStatusText, type AutopilotAcceptanceCard, type AutopilotCreatedQuoteView } from './AutopilotPanel';
import { AutopilotDoneList } from './AutopilotDoneList';
import { AutopilotCommandBar } from './AutopilotCommandBar';
import type { AutopilotSignalCard } from './AutopilotSignalList';
import type { AutopilotActionCard } from './AutopilotActionList';
import type { AutopilotView } from './autopilotView';
import type { BriefActivity, BriefDestination } from './AutomationBrief';

/*
 * "Aujourd'hui": everything Autopilote prepared, one thing at a time.
 * Left, the list of what waits; right, the open item with what was received
 * and what Zentra prepared, and one green button. Presentation only: every
 * button calls the same handler as the card it replaces, nothing runs alone.
 */

type Copy = Readonly<Record<string, readonly [string, string, string, string]>>;
const copy: Copy = {
  none: ['Tout est à jour.', 'Alles ist erledigt.', 'Tutto è in ordine.', 'You are all caught up.'],
  one: ['Une chose à valider.', 'Eine Sache zu bestätigen.', 'Una cosa da approvare.', 'One thing to approve.'],
  many: ['{n} choses à valider.', '{n} Dinge zu bestätigen.', '{n} cose da approvare.', '{n} things to approve.'],
  leadWaiting: ['Autopilote a lu vos e-mails, votre banque et votre stock. Le reste est déjà fait.', 'Autopilote hat Ihre E-Mails, Ihre Bank und Ihr Lager gelesen. Der Rest ist schon erledigt.', 'Autopilote ha letto le e-mail, la banca e il magazzino. Il resto è già fatto.', 'Autopilote read your e-mails, your bank and your stock. The rest is already done.'],
  leadNone: ['Autopilote veille sur vos e-mails et votre banque. Rien ne vous attend.', 'Autopilote behält Ihre E-Mails und Ihre Bank im Blick. Nichts wartet auf Sie.', 'Autopilote controlla le e-mail e la banca. Nulla ti aspetta.', 'Autopilote watches your e-mails and your bank. Nothing is waiting for you.'],
  progress: ['{done} sur {total} faits aujourd’hui', '{done} von {total} heute erledigt', '{done} su {total} fatti oggi', '{done} of {total} done today'],
  queue: ['À valider', 'Zu bestätigen', 'Da approvare', 'To approve'],
  then: ['Ensuite', 'Danach', 'Poi', 'Next'],
  received: ['Reçu', 'Erhalten', 'Ricevuto', 'Received'],
  prepared: ['Préparé par Zentra', 'Von Zentra vorbereitet', 'Preparato da Zentra', 'Prepared by Zentra'],
  position: ['{i} sur {n}', '{i} von {n}', '{i} di {n}', '{i} of {n}'],
  previous: ['Précédent', 'Zurück', 'Precedente', 'Previous'],
  next: ['Suivant', 'Weiter', 'Successivo', 'Next'],
  later: ['Plus tard', 'Später', 'Più tardi', 'Later'],
  doneTitle: ['C’est fait.', 'Erledigt.', 'Fatto.', 'All done.'],
  doneText: ['Autopilote repasse dès qu’un e-mail ou un paiement arrive.', 'Autopilote meldet sich, sobald eine E-Mail oder eine Zahlung eintrifft.', 'Autopilote ripassa appena arriva un’e-mail o un pagamento.', 'Autopilote comes back as soon as an e-mail or a payment arrives.'],
  doneEmpty: ['Rien encore aujourd’hui.', 'Heute noch nichts.', 'Ancora nulla oggi.', 'Nothing yet today.'],
  doneHeading: ['Fait par Zentra', 'Von Zentra erledigt', 'Fatto da Zentra', 'Done by Zentra'],
  mailFrom: ['E-mail de {sender}', 'E-Mail von {sender}', 'E-mail di {sender}', 'E-mail from {sender}'],
  openMail: ['Voir l’e-mail', 'E-Mail ansehen', 'Vedi l’e-mail', 'View the e-mail'],
  quoteKind: ['Devis', 'Offerte', 'Preventivo', 'Quote'],
  invoiceKind: ['Facture', 'Rechnung', 'Fattura', 'Invoice'],
  manageKind: ['Gestion', 'Verwaltung', 'Gestione', 'Management'],
  linesTitle: ['Lignes reprises de la demande', 'Aus der Anfrage übernommene Positionen', 'Righe riprese dalla richiesta', 'Lines taken from the request'],
  subtotal: ['Sous-total', 'Zwischensumme', 'Subtotale', 'Subtotal'],
  vat: ['TVA', 'MWST', 'IVA', 'VAT'],
  total: ['Total', 'Total', 'Totale', 'Total'],
  toLink: ['{n} ligne(s) à relier au catalogue', '{n} Position(en) mit dem Katalog verknüpfen', '{n} riga/e da collegare al catalogo', '{n} line(s) to link to the catalogue'],
  noLines: ['Zentra n’a pas encore trouvé de ligne sûre. Ouvrez la demande pour la compléter.', 'Zentra hat noch keine sichere Position gefunden. Öffnen Sie die Anfrage, um sie zu ergänzen.', 'Zentra non ha ancora trovato righe sicure. Apri la richiesta per completarla.', 'Zentra has not found a reliable line yet. Open the request to complete it.'],
  briefText: ['Zentra a préparé ces éléments dans Gestion. Ouvrez-les pour les vérifier, rien n’est enregistré sans vous.', 'Zentra hat diese Elemente in der Verwaltung vorbereitet. Öffnen Sie sie zur Prüfung, nichts wird ohne Sie gespeichert.', 'Zentra ha preparato questi elementi in Gestione. Aprili per verificarli, nulla viene salvato senza di te.', 'Zentra prepared these items in Management. Open them to check; nothing is saved without you.'],
  open: ['Ouvrir', 'Öffnen', 'Apri', 'Open'],
  enter: ['Entrée', 'Enter', 'Invio', 'Enter'],
  briefInvoices: ['Factures à vérifier', 'Rechnungen prüfen', 'Fatture da verificare', 'Invoices to review'],
  briefAppointments: ['Rendez-vous à compléter', 'Termine vervollständigen', 'Appuntamenti da completare', 'Appointments to complete'],
  briefReview: ['Actions à valider', 'Aktionen bestätigen', 'Azioni da approvare', 'Actions to approve'],
  briefWork: ['Tâches et réponses préparées', 'Vorbereitete Aufgaben und Antworten', 'Attività e risposte preparate', 'Prepared tasks and replies'],
  briefTools: ['Classements à vérifier', 'Zuordnungen prüfen', 'Classificazioni da verificare', 'Classifications to review'],
  settings: ['Réglages', 'Einstellungen', 'Impostazioni', 'Settings'],
  observation: ['Mode observation : Autopilote prépare sans rien modifier.', 'Beobachtungsmodus: Autopilote bereitet vor, ohne etwas zu ändern.', 'Modalità osservazione: Autopilote prepara senza modificare nulla.', 'Observation mode: Autopilote prepares without changing anything.'],
};

// Same output as the app's money format, from the language given to the page.
const locales = ['fr-CH', 'de-CH', 'it-CH', 'en-CH'] as const;
const localeOf = (language: string) => locales[Math.max(0, ['fr', 'de', 'it', 'en'].indexOf(language))];
const formatMoney = (cents: number, currency: string, language: string) =>
  new Intl.NumberFormat(localeOf(language), { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);

type Entry = Readonly<{ id: string; kind: string; title: string; sub?: string; side?: string }> & (
  | { type: 'request'; item: AutopilotReviewItem }
  | { type: 'acceptance'; card: AutopilotAcceptanceCard }
  | { type: 'signal'; card: AutopilotSignalCard }
  | { type: 'followup'; card: AutopilotActionCard }
  | { type: 'brief'; destination: BriefDestination; count: number });

export type AutopilotTodayProps = {
  language: string; organizationId: string; observation: boolean;
  activity?: BriefActivity | null; onOpen: (destination: BriefDestination) => void; onSettings: () => void;
  onOpenSource: (sourceId: string) => Promise<unknown>;
  state: AutopilotView | null;
  onNextReviews?: () => Promise<void>; onRefresh?: () => Promise<void>;
  onCatalogue?: (item: Pick<AutopilotReviewItem, 'proposalId' | 'sourceId'>, mode: 'browse' | 'create') => void;
  canAddCatalogue?: boolean;
  onCreateQuote?: (item: AutopilotReviewItem) => void;
  createdQuote?: (item: AutopilotRequestKey) => AutopilotCreatedQuoteView | null;
  onOpenCreatedQuote?: (item: AutopilotRequestKey) => void; onSendCreatedQuote?: (item: AutopilotRequestKey) => void;
  acceptances?: readonly AutopilotAcceptanceCard[]; onChooseAcceptance?: (sourceId: string, quoteId: string | null) => void;
  signals?: readonly AutopilotSignalCard[]; onSignal?: (sourceId: string, choiceId?: string) => void; onIgnoreSignal?: (sourceId: string) => void;
  followUps?: readonly AutopilotActionCard[]; onFollowUp?: (key: string, actionId: string) => void;
  journal?: readonly JournalEntry[]; onUndo?: (entry: JournalEntry) => void;
  onAsk?: (text: string) => void; asking?: boolean; askNotUnderstood?: boolean;
  onCreateInvoice?: (item: AutopilotRequestKey) => void; onSendInvoice?: (item: AutopilotRequestKey) => void; onOpenInvoice?: (item: AutopilotRequestKey) => void;
  catalogueArticles?: readonly Readonly<{ id: string; name: string }>[];
  onChooseArticle?: (phrase: string, articleId: string) => Promise<string>;
  onCreateArticle?: (item: AutopilotReviewItem, phrase: string) => void;
};

export function AutopilotToday(props: AutopilotTodayProps) {
  const { language, organizationId, state, createdQuote, acceptances = [], signals = [], followUps = [], journal = [] } = props;
  const index = Math.max(0, ['fr', 'de', 'it', 'en'].indexOf(language));
  const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), copy[key][index]);
  const common = autopilotCopy(language);
  const readable = state?.status === 'ready' && !state.reviewsUnavailable;
  const page = readable ? normalizeAutopilotReviewPage(state.reviews, organizationId) : null;
  const stageOf = (key: AutopilotRequestKey) => autopilotRequestStage(createdQuote?.(key) ?? null);

  // The same items, in the same order of importance, as the cards they replace.
  const entries: Entry[] = [];
  if (readable) {
    for (const item of page?.items ?? []) {
      const stage = stageOf(item);
      if (stage === 'done') continue;
      const quote = createdQuote?.(item) ?? null, s = item.suggestion;
      const who = s?.customer?.name ?? s?.sender?.company ?? s?.sender?.name ?? common.acceptanceUnknownSender;
      entries.push({ id: `request:${item.proposalId}`, type: 'request', item, kind: stage === 'accepted' ? say('invoiceKind') : say('quoteKind'),
        title: stage === 'accepted' && quote ? common.acceptedTitle.replace('{number}', quote.number) : who,
        sub: stage === 'accepted' ? quote?.clientName : common.request, side: s && s.netCents > 0 ? formatMoney(s.netCents, s.currency, language) : undefined });
    }
    for (const card of acceptances) {
      const accepted = !card.candidates && stageOf({ proposalId: card.key }) === 'accepted';
      if (!card.candidates && !accepted) continue;
      const quote = accepted ? createdQuote?.({ proposalId: card.key }) ?? null : null;
      entries.push({ id: `acceptance:${card.key}`, type: 'acceptance', card, kind: accepted ? say('invoiceKind') : say('quoteKind'),
        title: quote ? common.acceptedTitle.replace('{number}', quote.number) : common.acceptanceChooseTitle.replace('{sender}', card.sender || common.acceptanceUnknownSender),
        sub: quote?.clientName ?? card.sender });
    }
    for (const card of signals) entries.push({ id: `signal:${card.sourceId}`, type: 'signal', card, kind: common.kindMail, title: card.title, sub: card.sender });
    for (const card of followUps) {
      const kind = autopilotKind(card.key);
      entries.push({ id: `followup:${card.key}`, type: 'followup', card, kind: kind ? t(kind) : 'Autopilote', title: card.title, sub: card.detail });
    }
  }
  const brief: [BriefDestination, number, string][] = [
    ['invoices', props.activity?.supplierInbox?.needsReview ?? 0, 'briefInvoices'],
    ['appointments', props.activity?.appointments?.pending ?? 0, 'briefAppointments'],
    ['review', props.activity?.workflows?.review ?? 0, 'briefReview'],
    ['work', props.activity?.workflows?.open ?? 0, 'briefWork'],
    ['tools', props.activity?.totals.needsReview ?? 0, 'briefTools'],
  ];
  for (const [destination, count, label] of brief) if (count > 0) entries.push({ id: `brief:${destination}`, type: 'brief', destination, count, kind: say('manageKind'), title: say(label), side: String(count) });

  // Brief rows stand for several items: the title counts them all, like the sidebar badge.
  const waiting = entries.reduce((total, entry) => total + (entry.type === 'brief' ? entry.count : 1), 0);
  const done = doneToday(journal).length;
  const total = waiting + done;

  const [selected, setSelected] = useState<string | null>(null);
  const lastIndex = useRef(0);
  // When the open item leaves the list (validated), the next one takes its place.
  const current = entries.find(entry => entry.id === selected) ?? entries[Math.min(lastIndex.current, entries.length - 1)] ?? null;
  const at = current ? entries.indexOf(current) : -1;
  useEffect(() => { if (current) { lastIndex.current = at; if (current.id !== selected) setSelected(current.id); } }, [current?.id]);
  const focusRef = useRef<HTMLElement>(null);
  const choose = (id: string, reveal = false) => {
    setSelected(id);
    if (reveal && window.matchMedia?.('(max-width: 860px)').matches) requestAnimationFrame(() => focusRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const step = (delta: number) => { if (entries.length) choose(entries[(at + delta + entries.length) % entries.length].id); };

  // Enter validates the open item; arrows move in the list. Never while typing.
  const keys = useRef({ step, at });
  keys.current = { step, at };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]') || (target.closest('button, a, summary') && event.key === 'Enter'))) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); keys.current.step(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); keys.current.step(-1); }
      else if (event.key === 'Enter') {
        const primary = focusRef.current?.querySelector<HTMLButtonElement>('[data-primary]:not(:disabled), .quote-autopilot__create-quote.is-ready:not(:disabled)');
        if (primary) { event.preventDefault(); primary.click(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const date = new Intl.DateTimeFormat(localeOf(language), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const headline = waiting === 0 ? say('none') : waiting === 1 ? say('one') : say('many', { n: waiting });
  const segments = Math.min(total, 24);
  const filled = total ? Math.round(done / total * segments) : 0;
  const statusLine = state && !readable ? autopilotStatusText(state, language) : null;

  return <div className="autopilot-today" data-empty={entries.length === 0 || undefined}>
    <header className="autopilot-today__hero">
      <div>
        <p className="autopilot-today__date">{date.charAt(0).toLocaleUpperCase(localeOf(language)) + date.slice(1)}</p>
        <h2>{headline}</h2>
        <p className="autopilot-today__lead">{waiting ? say('leadWaiting') : say('leadNone')}{props.observation ? <> {say('observation')}</> : null}</p>
      </div>
      <div className="autopilot-today__side">
        {total > 0 && <div className="autopilot-today__progress" aria-label={say('progress', { done, total })}>
          <span>{say('progress', { done, total })}</span>
          <div className="autopilot-today__segments" aria-hidden="true">{Array.from({ length: segments }, (_, i) => <i key={i} data-on={i < filled || undefined} />)}</div>
        </div>}
        <button type="button" className="autopilot-today__settings" onClick={props.onSettings}><Settings2 size={16} aria-hidden="true" />{say('settings')}</button>
      </div>
    </header>
    {props.onAsk && readable && <div className="autopilot-today__ask"><AutopilotCommandBar onAsk={props.onAsk} busy={props.asking ?? false} notUnderstood={props.askNotUnderstood ?? false} /></div>}
    {statusLine && <p className="autopilot-today__status" role="status">{statusLine}</p>}

    <div className="autopilot-today__grid">
      <aside className="autopilot-today__aside">
        {entries.length > 0 && <>
          <h3 className="autopilot-today__label"><span className="autopilot-today__label-wide">{say('queue')}</span><span className="autopilot-today__label-narrow">{say('then')}</span></h3>
          <ol className="autopilot-today__queue">{entries.map((entry, i) => <li key={entry.id}>
            <button type="button" aria-current={entry.id === current?.id || undefined} onClick={() => choose(entry.id, true)}>
              <span className="autopilot-today__n">{i + 1}</span>
              <span className="autopilot-today__what"><small>{entry.kind}</small><strong>{entry.title}</strong></span>
              {entry.side ? <span className="autopilot-today__amount">{entry.side}</span> : null}
            </button>
          </li>)}</ol>
        </>}
        <section className="autopilot-today__done" aria-label={say('doneHeading')}>
          <h3 className="autopilot-today__label">{say('doneHeading')}</h3>
          {done ? <AutopilotDoneList entries={journal} onUndo={props.onUndo} /> : <p className="autopilot-today__quiet">{say('doneEmpty')}</p>}
          <button type="button" className="autopilot-today__link" onClick={() => props.onOpen('history')}>{t('Voir l’activité')}<ChevronRight size={15} aria-hidden="true" /></button>
        </section>
      </aside>

      <section className="autopilot-today__focus" ref={focusRef} aria-live="polite" aria-label={current?.title ?? say('doneTitle')}>
        {current ? <>
          <header className="autopilot-today__focus-head">
            <div><small>{current.kind}</small><h3>{current.title}</h3>{current.sub && current.sub !== current.title ? <p>{current.sub}</p> : null}</div>
            {entries.length > 1 && <nav className="autopilot-today__pager" aria-label={say('position', { i: at + 1, n: entries.length })}>
              <span>{say('position', { i: at + 1, n: entries.length })}</span>
              <button type="button" aria-label={say('previous')} onClick={() => step(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
              <button type="button" aria-label={say('next')} onClick={() => step(1)}><ChevronRight size={18} aria-hidden="true" /></button>
            </nav>}
          </header>
          <Focus key={current.id} entry={current} props={props} say={say} onLater={entries.length > 1 ? () => step(1) : undefined} />
        </> : <div className="autopilot-today__clear">
          <span className="autopilot-today__check" aria-hidden="true"><Check size={26} strokeWidth={2.5} /></span>
          <h3>{say('doneTitle')}</h3>
          <p>{say('doneText')}</p>
        </div>}
      </section>
    </div>
  </div>;
}

function Focus({ entry, props, say, onLater }: { entry: Entry; props: AutopilotTodayProps; say: (key: string, values?: Record<string, string | number>) => string;
  onLater?: () => void }) {
  const common = autopilotCopy(props.language);
  const time = (seconds: number) => new Intl.DateTimeFormat(localeOf(props.language), { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000);
  const later = onLater ? <button type="button" className="autopilot-today__ghost" onClick={onLater}>{say('later')}</button> : null;

  if (entry.type === 'request' || entry.type === 'acceptance') {
    // The request keeps its own card (articles to link, quote, sending): only shown here, one at a time.
    const item = entry.type === 'request' ? entry.item : null;
    const s = item?.suggestion;
    const sender = s?.sender;
    const net = s ? s.lines.reduce((sum, line) => sum + line.netCents, 0) : 0;
    const vat = s ? s.lines.reduce((sum, line) => sum + Math.round(line.netCents * line.taxRateBp / 10000), 0) : 0;
    const only = props.state && item ? { ...props.state, reviews: props.state.reviews ? { ...props.state.reviews, items: [item], nextCursor: null } : null } as AutopilotView : props.state;
    const emptyReviews = props.state ? { ...props.state, reviews: props.state.reviews ? { ...props.state.reviews, items: [], nextCursor: null } : null } as AutopilotView : null;
    return <>
      {item && <div className="autopilot-today__pair">
        <div className="autopilot-today__received">
          <h4>{say('received')}</h4>
          <p className="autopilot-today__from">{say('mailFrom', { sender: sender?.name ?? sender?.company ?? sender?.email ?? common.acceptanceUnknownSender })}</p>
          <p className="autopilot-today__meta">{[sender?.company, sender?.email, sender?.city].filter(Boolean).join(' · ')}</p>
          <p className="autopilot-today__meta">{time(item.createdAt)}</p>
          <button type="button" className="autopilot-today__ghost" onClick={() => { void props.onOpenSource(item.sourceId).catch(() => undefined); }}>{say('openMail')}<ArrowUpRight size={15} aria-hidden="true" /></button>
        </div>
        <div className="autopilot-today__prepared">
          <h4>{say('prepared')}</h4>
          {s && s.lines.length ? <table className="autopilot-today__lines"><caption>{say('linesTitle')}</caption><tbody>
            {s.lines.map((line, i) => <tr key={i}><td>{line.description}<small>{`${(line.quantityMilli / 1000).toLocaleString(localeOf(props.language))} ${line.unit} × ${formatMoney(line.unitPriceCents, s.currency, props.language)}`}</small></td><td>{formatMoney(line.netCents, s.currency, props.language)}</td></tr>)}
            <tr className="autopilot-today__sum"><td>{say('subtotal')}</td><td>{formatMoney(net, s.currency, props.language)}</td></tr>
            <tr className="autopilot-today__sum"><td>{say('vat')}</td><td>{formatMoney(vat, s.currency, props.language)}</td></tr>
            <tr className="autopilot-today__total"><td>{say('total')}</td><td>{formatMoney(net + vat, s.currency, props.language)}</td></tr>
          </tbody></table> : <p className="autopilot-today__quiet">{say('noLines')}</p>}
          {s?.unmatched?.length ? <p className="autopilot-today__note">{say('toLink', { n: s.unmatched.length })}</p> : null}
        </div>
      </div>}
      <div className="autopilot-today__card">
        <AutopilotReviews state={(item ? only : emptyReviews)!} organizationId={props.organizationId} onOpenSource={props.onOpenSource}
          onCatalogue={props.onCatalogue} canAddCatalogue={props.canAddCatalogue} onCreateQuote={props.onCreateQuote}
          acceptances={entry.type === 'acceptance' ? [entry.card] : []} onChooseAcceptance={props.onChooseAcceptance}
          createdQuote={props.createdQuote} onOpenCreatedQuote={props.onOpenCreatedQuote} onSendCreatedQuote={props.onSendCreatedQuote}
          onCreateInvoice={props.onCreateInvoice} onSendInvoice={props.onSendInvoice} onOpenInvoice={props.onOpenInvoice}
          catalogueArticles={props.catalogueArticles} onChooseArticle={props.onChooseArticle} onCreateArticle={props.onCreateArticle} />
      </div>
      {later && <div className="autopilot-today__actions">{later}</div>}
    </>;
  }

  if (entry.type === 'signal') return <SignalFocus card={entry.card} props={props} say={say} time={time} later={later} />;

  if (entry.type === 'followup') {
    const card = entry.card;
    const primary = card.actions.find(action => action.primary);
    const others = card.actions.filter(action => action !== primary);
    const act = props.onFollowUp;
    return <>
      <div className={card.evidence ? 'autopilot-today__pair' : 'autopilot-today__single'}>
        {card.evidence && <div className="autopilot-today__received">
          <h4>{say('received')}</h4>
          <blockquote>{card.evidence}</blockquote>
        </div>}
        <div className="autopilot-today__prepared">
          <h4>{say('prepared')}</h4>
          <p className="autopilot-today__what-next">{primary?.label ?? card.title}</p>
          <p className="autopilot-today__meta">{card.detail}</p>
          {card.note ? <p className="autopilot-today__note">{card.note}</p> : null}
          {card.why ? <p className="autopilot-today__why">{card.why}</p> : null}
        </div>
      </div>
      <div className="autopilot-today__actions">
        {act && others.map(action => <button key={action.id} type="button" className="autopilot-today__secondary" onClick={() => act(card.key, action.id)}>{action.label}</button>)}
        {later}
        {act && primary && <button type="button" className="autopilot-today__primary" data-primary onClick={() => act(card.key, primary.id)}>{primary.label}<kbd>{say('enter')}</kbd></button>}
      </div>
    </>;
  }

  return <>
    <div className="autopilot-today__single"><div className="autopilot-today__prepared">
      <h4>{say('prepared')}</h4>
      <p className="autopilot-today__what-next">{entry.title} · {entry.count}</p>
      <p className="autopilot-today__meta">{say('briefText')}</p>
    </div></div>
    <div className="autopilot-today__actions">{later}<button type="button" className="autopilot-today__primary" data-primary onClick={() => props.onOpen(entry.destination)}>{say('open')}<kbd>{say('enter')}</kbd></button></div>
  </>;
}

function SignalFocus({ card, props, say, time, later }: { card: AutopilotSignalCard; props: AutopilotTodayProps; say: (key: string, values?: Record<string, string | number>) => string;
  time: (seconds: number) => string; later: ReactNode }) {
  const common = autopilotCopy(props.language);
  const [choice, setChoice] = useState(card.candidates?.length === 1 ? card.candidates[0].id : '');
  const blocked = !!card.candidates?.length && !choice;
  return <>
    <div className="autopilot-today__pair">
      <div className="autopilot-today__received">
        <h4>{say('received')}</h4>
        <p className="autopilot-today__from">{say('mailFrom', { sender: card.sender || common.acceptanceUnknownSender })}</p>
        <p className="autopilot-today__meta">{time(card.receivedAt)}</p>
        <blockquote>{card.evidence}</blockquote>
      </div>
      <div className="autopilot-today__prepared">
        <h4>{say('prepared')}</h4>
        <p className="autopilot-today__what-next">{card.actionLabel ?? common.signalNothingFound}</p>
        {card.candidates?.length ? <label className="autopilot-today__pick">{common.signalWhichInvoice}
          <select value={choice} onChange={event => setChoice(event.target.value)}>
            <option value="">{common.signalPickInvoice}</option>
            {card.candidates.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select></label> : null}
      </div>
    </div>
    <div className="autopilot-today__actions">
      {props.onIgnoreSignal && <button type="button" className="autopilot-today__secondary" onClick={() => props.onIgnoreSignal!(card.sourceId)}>{common.acceptanceDismiss}</button>}
      {later}
      {props.onSignal && card.actionLabel ? <button type="button" className="autopilot-today__primary" data-primary disabled={blocked} onClick={() => props.onSignal!(card.sourceId, choice || undefined)}>{card.actionLabel}<kbd>{say('enter')}</kbd></button> : null}
    </div>
  </>;
}
