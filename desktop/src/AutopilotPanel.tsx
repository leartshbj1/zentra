import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, ChevronRight, ClipboardCheck, Mail, Workflow } from 'lucide-react';
import { useAppLanguage, getAppLocale } from './language';
import { autopilotCopy, autopilotCatalogueCopy, autopilotReviewReason } from './autopilotPresentation';
import { normalizeAutopilotReviewPage, type AutopilotReviewItem, type AutopilotRequestKey } from './autopilotReview';
import { autopilotLineLinks, saveAutopilotLineLink, type AutopilotLineLink } from './autopilotLinks';
import { autopilotRequestStage } from './autopilotQuote';
import { AutopilotSignals, type AutopilotSignalCard } from './AutopilotSignalList';
import { AutopilotActionList, type AutopilotActionCard } from './AutopilotActionList';
import type { AutopilotView } from './autopilotView';
import './AutopilotPanel.css';

function statusText(state: AutopilotView, language: string) {
  const copy = autopilotCopy(language);
  if (state.status === 'checking') return copy.checking;
  if (state.status === 'offline') return copy.offline;
  if (state.status === 'disconnected') return copy.disconnected;
  if (state.error === 'permission') return copy.permission;
  if (state.error === 'conflict') return copy.conflict;
  if (state.error === 'rate_limited') return copy.rateLimited;
  if (state.error === 'quota_exhausted') return copy.monthlyQuota;
  if (state.status === 'error') return copy.connection;
  if (state.status === 'ready' && !state.canManage && !state.consent) return copy.shared;
  if (state.status !== 'ready' || !state.consent) return copy.unavailable;
  return state.consent.enabled && state.consent.consentVersion === state.consent.requiredConsentVersion ? copy.active : copy.paused;
}

export function AutopilotStatus({ state, onSettings }: { state: AutopilotView; onSettings: () => void }) {
  const language = useAppLanguage(), copy = autopilotCopy(language);
  return <section className="quote-autopilot quote-autopilot--status" aria-label={copy.title}>
    <Workflow size={21} aria-hidden="true" />
    <div><strong>{copy.title}</strong><span>{statusText(state, language)}</span></div>
    <button type="button" onClick={onSettings}>{copy.settings}<ChevronRight size={16} aria-hidden="true" /></button>
  </section>;
}

export function AutopilotSettings({ state, onConsent }: { state: AutopilotView; onConsent: (enabled: boolean) => Promise<void> }) {
  const language = useAppLanguage(), copy = autopilotCopy(language);
  const admitted = state.status === 'ready' && state.consent !== null;
  const errorText = state.error === 'save' ? copy.saveError : state.error === 'context_changed' ? copy.contextChanged
    : state.error === 'busy' ? copy.busy : state.error === 'connection' ? copy.connection : state.error === 'permission' ? copy.permission
      : state.error === 'conflict' ? copy.conflict : state.error === 'rate_limited' ? copy.rateLimited : state.error === 'quota_exhausted' ? copy.monthlyQuota : null;
  return <section className="quote-autopilot quote-autopilot--settings" aria-labelledby="quote-autopilot-settings-title">
    <header><div><h2 id="quote-autopilot-settings-title">{copy.title}</h2><p>{copy.consentTitle}</p></div></header>
    {admitted ? <>
      <label className="quote-autopilot__consent">
        <input type="checkbox" checked={state.consent!.enabled && state.consent!.consentVersion === state.consent!.requiredConsentVersion} disabled={!state.canManage || state.saving}
          onChange={event => { void onConsent(event.target.checked); }} />
        <span><strong>{copy.consent}</strong><small>{copy.consentDetail}</small></span>
      </label>
      {!state.canManage && <p className="quote-autopilot__context">{copy.admin}</p>}
      {state.consent!.enabled && state.consent!.consentVersion === state.consent!.requiredConsentVersion && <p className="quote-autopilot__context">{copy.background}</p>}
    </> : <p className="quote-autopilot__context" role="status">{state.status === 'ready' && !state.canManage ? copy.admin : statusText(state, language)}</p>}
    {state.saving && <p className="quote-autopilot__context" role="status">{copy.saving}</p>}
    {errorText && <p className="quote-autopilot__error" role="status">{errorText}</p>}
  </section>;
}

/** One request line without an article: pick one from the catalogue or create it; the choice is remembered. */
function UnmatchedLine({ phrase, catalogue, disabled, onChoose, onCreate, onLinked, initial }: {
  phrase: string; catalogue: readonly Readonly<{ id: string; name: string }>[]; disabled: boolean;
  onChoose?: (phrase: string, articleId: string) => Promise<string>; onCreate?: (phrase: string) => void;
  onLinked?: (phrase: string, link: AutopilotLineLink | null) => void;
  initial?: AutopilotLineLink;
}) {
  const copy = autopilotCopy(useAppLanguage());
  const listId = useId();
  const [query, setQuery] = useState(''), [saving, setSaving] = useState(false);
  const [linked, setLinked] = useState<AutopilotLineLink | null>(initial ?? null), [error, setError] = useState('');
  // An exact name picks the article; otherwise the single partial match does.
  const wanted = query.trim().toLocaleLowerCase(getAppLocale());
  const exact = catalogue.find(article => article.name.toLocaleLowerCase(getAppLocale()) === wanted);
  const partial = wanted ? catalogue.filter(article => article.name.toLocaleLowerCase(getAppLocale()).includes(wanted)) : [];
  const article = exact ?? (partial.length === 1 ? partial[0] : undefined);
  const choose = async () => {
    if (!article || !onChoose || saving) return;
    setSaving(true); setError('');
    try {
      const term = await onChoose(phrase, article.id);
      const link = { articleId: article.id, name: article.name, term };
      setLinked(link); setQuery(''); onLinked?.(phrase, link);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : '';
      setError(code === 'forbidden' ? copy.chooseErrorRights : code === 'invalid_request' ? copy.chooseErrorInvalid : copy.chooseErrorService);
    } finally { setSaving(false); }
  };
  return <li className={linked ? 'is-linked' : undefined}>
    <div className="quote-autopilot__unmatched-line"><q>{phrase}</q>
      {linked && <span className="quote-autopilot__linked"><Check size={15} aria-hidden="true" />{copy.linkedTo.replace('{name}', linked.name)}</span>}</div>
    {linked ? <>
      <p className="quote-autopilot__remembered" role="status">{copy.remembered.replace('{term}', linked.term)}</p>
      {onChoose && <button type="button" className="quote-autopilot__change" disabled={disabled} onClick={() => { setLinked(null); onLinked?.(phrase, null); }}>{copy.changeArticle}</button>}
    </> : <form className="quote-autopilot__unmatched-actions" onSubmit={event => { event.preventDefault(); void choose(); }}>
      {onChoose && <>
        <input type="search" list={listId} value={query} placeholder={copy.searchArticle} aria-label={copy.searchArticle}
          disabled={disabled || saving} onChange={event => { setQuery(event.target.value); setError(''); }} />
        <datalist id={listId}>{catalogue.map(row => <option key={row.id} value={row.name} />)}</datalist>
        <button type="submit" className="quote-autopilot__link" disabled={disabled || saving || !article}>{copy.linkArticle}</button>
      </>}
      {onCreate && <button type="button" disabled={disabled || saving} onClick={() => onCreate(phrase)}>{copy.createArticle}</button>}
      {onChoose && wanted && !partial.length && <p className="quote-autopilot__hint">{copy.noMatch}</p>}
    </form>}
    {error && <p className="quote-autopilot__error" role="alert">{error}</p>}
  </li>;
}

/** All request lines of one review; the intro turns into a go-ahead once every line is linked. */
function UnmatchedLines({ phrases, catalogue, disabled, onChoose, onCreate, links, onLinked }: {
  phrases: readonly string[]; catalogue: readonly Readonly<{ id: string; name: string }>[]; disabled: boolean;
  onChoose?: (phrase: string, articleId: string) => Promise<string>; onCreate?: (phrase: string) => void;
  links: Readonly<Record<string, AutopilotLineLink>>; onLinked: (phrase: string, link: AutopilotLineLink | null) => void;
}) {
  const copy = autopilotCopy(useAppLanguage());
  const all = phrases.every(phrase => links[phrase]);
  return <div className="quote-autopilot__unmatched">
    <strong>{copy.unmatchedTitle}</strong>
    <p>{all ? copy.allLinked : copy.unmatchedIntro}</p>
    <ul>{phrases.map(phrase => <UnmatchedLine key={phrase} phrase={phrase} catalogue={catalogue} disabled={disabled}
      onChoose={onChoose} onCreate={onCreate} initial={links[phrase]} onLinked={onLinked} />)}</ul>
  </div>;
}

/** A client mail accepting a quote, outside any request. */
export type AutopilotAcceptanceCard = Readonly<{ key: string; sourceId: string; receivedAt: number; evidence: string; sender: string;
  /** Present when the quote could not be found alone: the person picks it. */ candidates?: readonly Readonly<{ id: string; label: string }>[] }>;

function AcceptanceChoice({ card, disabled, onChoose }: { card: AutopilotAcceptanceCard; disabled: boolean; onChoose?: (sourceId: string, quoteId: string | null) => void }) {
  const copy = autopilotCopy(useAppLanguage());
  const [quoteId, setQuoteId] = useState(card.candidates?.length === 1 ? card.candidates[0].id : '');
  return <li data-state="choose">
    <div className="quote-autopilot__row">
      <div className="quote-autopilot__row-text"><strong>{copy.acceptanceChooseTitle.replace('{sender}', card.sender || copy.acceptanceUnknownSender)}</strong>
        <span>{card.candidates?.length ? copy.rowChoose : copy.acceptanceNoQuote}</span></div>
    </div>
    <div className="quote-autopilot__body">
      <blockquote className="quote-autopilot__evidence">{card.evidence}</blockquote>
      {card.candidates?.length ? <label className="quote-autopilot__acceptance-pick">{copy.acceptanceWhichQuote}
        <select value={quoteId} disabled={disabled} onChange={event => setQuoteId(event.target.value)}>
          <option value="">{copy.acceptancePick}</option>
          {card.candidates.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
        </select></label> : null}
      <div className="quote-autopilot__request-actions">
        {onChoose && card.candidates?.length ? <button type="button" className="quote-autopilot__create-quote is-ready" disabled={disabled || !quoteId} onClick={() => onChoose(card.sourceId, quoteId)}>{copy.acceptanceConfirm}</button> : null}
        {onChoose && <button type="button" disabled={disabled} onClick={() => onChoose(card.sourceId, null)}>{copy.acceptanceDismiss}</button>}
      </div>
      <time dateTime={new Date(card.receivedAt * 1000).toISOString()}>{new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(card.receivedAt * 1000)}</time>
    </div>
  </li>;
}

/** A request whose quote the client accepted: the invoice is made, then sent, the same way. */
function AcceptedRequest({ quote, disabled, onCreate, onSend, onOpen }: { quote: AutopilotCreatedQuoteView; disabled: boolean;
  onCreate?: () => void; onSend?: () => void; onOpen?: () => void }) {
  const copy = autopilotCopy(useAppLanguage());
  const invoice = quote.invoice;
  return <li data-state="accepted">
    <div className="quote-autopilot__row">
      <div className="quote-autopilot__row-text"><strong>{copy.acceptedTitle.replace('{number}', quote.number)}{quote.clientName ? ` · ${quote.clientName}` : ''}</strong>
        <span>{invoice ? (invoice.issued ? copy.invoiceDone.replace('{number}', invoice.number) : `${copy.invoiceDraftDone} ${copy.sendInvoiceHint}`) : copy.rowAccepted}</span></div>
      <div className="quote-autopilot__row-action">
        {invoice ? onSend && <button type="button" className="quote-autopilot__create-quote is-ready" disabled={disabled} onClick={onSend}><Mail size={16} aria-hidden="true" />{copy.sendQuote}</button>
          : onCreate && <button type="button" className="quote-autopilot__create-quote is-ready" disabled={disabled} onClick={onCreate}>{copy.createInvoice}</button>}
      </div>
    </div>
    {invoice && onOpen && <div className="quote-autopilot__request-actions"><button type="button" disabled={disabled} onClick={onOpen}>{copy.openInvoice}</button></div>}
  </li>;
}

/** What the review card shows about the quote created from a request. */
export type AutopilotCreatedQuoteView = Readonly<{ number: string; issued: boolean; clientEmail: string; clientName?: string; sentAt?: number;
  /** The client accepted the quote; an invoice is the next step. */ accepted?: boolean;
  invoice?: Readonly<{ number: string; issued: boolean }>; invoiceSentAt?: number }>;

export function AutopilotReviews({ state, organizationId, onOpenSource, onNext, onRefresh, onCatalogue, canAddCatalogue = false, acceptances = [], onChooseAcceptance, signals = [], onSignal, onIgnoreSignal, followUps = [], followUpSummary, onFollowUp, onCreateQuote, createdQuote, onOpenCreatedQuote, onSendCreatedQuote, onCreateInvoice, onSendInvoice, onOpenInvoice, catalogueArticles = [], onChooseArticle, onCreateArticle }: {
  state: AutopilotView; organizationId: string; onOpenSource: (sourceId: string) => Promise<unknown>;
  onNext?: () => Promise<void>; onRefresh?: () => Promise<void>;
  onCatalogue?: (item: Pick<AutopilotReviewItem, 'proposalId' | 'sourceId'>, mode: 'browse' | 'create') => void;
  canAddCatalogue?: boolean;
  /** Client mails accepting a quote, outside any request. */
  acceptances?: readonly AutopilotAcceptanceCard[];
  onChooseAcceptance?: (sourceId: string, quoteId: string | null) => void;
  /** Proposals from other client and supplier mails (payments, refusals, purchases, complaints). */
  signals?: readonly AutopilotSignalCard[];
  onSignal?: (sourceId: string, choiceId?: string) => void;
  onIgnoreSignal?: (sourceId: string) => void;
  /** Reminders and quote follow-ups Autopilote prepared, with their one-line summary. */
  followUps?: readonly AutopilotActionCard[];
  followUpSummary?: string;
  onFollowUp?: (key: string, actionId: string) => void;
  /** Creates the quote at once, with its client and lines. */
  onCreateQuote?: (item: AutopilotReviewItem) => void;
  /** The quote already created from this request, if any. */
  createdQuote?: (item: AutopilotRequestKey) => AutopilotCreatedQuoteView | null;
  onOpenCreatedQuote?: (item: AutopilotRequestKey) => void;
  /** Numbers the quote if needed, then opens the e-mail to send it. */
  onSendCreatedQuote?: (item: AutopilotRequestKey) => void;
  /** Makes the invoice from the accepted quote in one step. */
  onCreateInvoice?: (item: AutopilotRequestKey) => void;
  /** Issues the invoice after the usual confirmation, then opens the e-mail. */
  onSendInvoice?: (item: AutopilotRequestKey) => void;
  onOpenInvoice?: (item: AutopilotRequestKey) => void;
  /** Local catalogue offered for request lines without an article. */
  catalogueArticles?: readonly Readonly<{ id: string; name: string }>[];
  /** Saves "this wording means this article"; resolves with the remembered wording. */
  onChooseArticle?: (phrase: string, articleId: string) => Promise<string>;
  /** Opens the article form filled with the request line; the choice is saved after creation. */
  onCreateArticle?: (item: AutopilotReviewItem, phrase: string) => void;
}) {
  const language = useAppLanguage(), copy = autopilotCopy(language), catalogue = autopilotCatalogueCopy(language);
  const [, setLinksVersion] = useState(0);
  const linksOf = (proposalId: string) => autopilotLineLinks(organizationId, proposalId);
  const remember = (proposalId: string) => (phrase: string, link: AutopilotLineLink | null) => {
    saveAutopilotLineLink(organizationId, proposalId, phrase, link); setLinksVersion(version => version + 1);
  };
  const page = useMemo(() => normalizeAutopilotReviewPage(state.reviews, organizationId), [state.reviews, organizationId]);
  const [opening, setOpening] = useState<string | null>(null), [openFailed, setOpenFailed] = useState(false);
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setOpening(null); setOpenFailed(false); return () => { epoch.current++; }; }, [organizationId]);
  const open = async (proposalId: string, sourceId: string) => {
    if (opening || state.status !== 'ready' || !page) return;
    const original = epoch.current; setOpening(proposalId); setOpenFailed(false);
    try { await onOpenSource(sourceId); }
    catch { if (epoch.current === original) setOpenFailed(true); }
    finally { if (epoch.current === original) setOpening(null); }
  };
  const readable = state.status === 'ready' && !!page && !state.reviewsUnavailable;
  // A request whose quote was sent is done: it leaves the list to follow.
  const stageOf = (item: AutopilotRequestKey) => autopilotRequestStage(createdQuote?.(item) ?? null);
  const sentOf = (item: AutopilotRequestKey) => stageOf(item) === 'done' ? createdQuote!(item) : null;
  const active = page ? page.items.filter(item => stageOf(item) !== 'done') : [];
  const finished: AutopilotRequestKey[] = page ? page.items.filter(item => stageOf(item) === 'done') : [];
  const acceptedCards = acceptances.filter(card => !card.candidates && stageOf({ proposalId: card.key }) === 'accepted');
  const choiceCards = acceptances.filter(card => card.candidates);
  finished.push(...acceptances.filter(card => !card.candidates && stageOf({ proposalId: card.key }) === 'done').map(card => ({ proposalId: card.key })));
  return <><section className="quote-autopilot quote-autopilot--reviews" aria-labelledby="quote-autopilot-review-title">
    <header><div><h2 id="quote-autopilot-review-title">{copy.reviewTitle}</h2><p>{copy.reviewDescription}</p></div>
      {onRefresh && <button type="button" disabled={state.readingReviews} onClick={() => { void onRefresh(); }}>{copy.refresh}</button>}
    </header>
    {!readable ? <p className="quote-autopilot__context" role="status">{state.status !== 'ready' ? statusText(state, language) : state.readingReviews ? copy.loading : copy.readError}</p>
      : active.length === 0 ? (choiceCards.length || acceptedCards.length || signals.length || followUps.length ? null : <p className="quote-autopilot__context">{finished.length ? copy.allDone : copy.empty}</p>)
        : <ol className="quote-autopilot__requests">{active.map(item => stageOf(item) === 'accepted' ? <AcceptedRequest key={item.proposalId}
          quote={createdQuote!(item)!} disabled={opening !== null} onCreate={onCreateInvoice ? () => onCreateInvoice(item) : undefined}
          onSend={onSendInvoice ? () => onSendInvoice(item) : undefined} onOpen={onOpenInvoice ? () => onOpenInvoice(item) : undefined} /> : (() => {
          const links = linksOf(item.proposalId), missing = item.suggestion?.unmatched ?? [];
          const linkedCount = missing.filter(phrase => links[phrase]).length;
          const canQuote = !!onCreateQuote && ((item.suggestion?.lines.length ?? 0) + linkedCount > 0);
          const linksDone = linkedCount === missing.length, quote = createdQuote?.(item) ?? null;
          const needsLinks = !quote && missing.length > 0 && !linksDone && !!(onChooseArticle || onCreateArticle);
          const customer = item.suggestion?.customer?.name;
          const title = `${item.reasons.includes('missing_article') ? catalogue.title : copy.request}${customer ? ` · ${customer}` : ''}`;
          const sentence = quote ? (quote.issued ? copy.quoteDone.replace('{number}', quote.number) : `${copy.quoteDraftDone} ${copy.sendQuoteHint}`)
            : needsLinks ? copy.rowLink : canQuote ? copy.rowReady : copy.rowManual;
          return <li key={item.proposalId} data-state={quote ? 'created' : needsLinks ? 'link' : canQuote ? 'ready' : 'manual'}>
            <div className="quote-autopilot__row">
              <div className="quote-autopilot__row-text"><strong>{title}</strong><span>{sentence}</span></div>
              <div className="quote-autopilot__row-action">
                {quote ? onSendCreatedQuote && <button type="button" className="quote-autopilot__create-quote is-ready" disabled={opening !== null} onClick={() => onSendCreatedQuote(item)}><Mail size={16} aria-hidden="true" />{copy.sendQuote}</button>
                  : canQuote ? <button type="button" className={linksDone ? 'quote-autopilot__create-quote is-ready' : 'quote-autopilot__create-quote'} disabled={opening !== null} onClick={() => onCreateQuote!(item)}>{copy.createQuote}</button>
                    : !needsLinks ? <button type="button" className="quote-autopilot__create-quote is-ready" disabled={opening !== null} onClick={() => { void open(item.proposalId, item.sourceId); }}>{copy.openRequest}<ArrowUpRight size={16} aria-hidden="true" /></button> : null}
              </div>
            </div>
            {!quote && missing.length && (onChooseArticle || onCreateArticle) ? <UnmatchedLines phrases={missing} catalogue={catalogueArticles} disabled={opening !== null} onChoose={onChooseArticle} links={links} onLinked={remember(item.proposalId)}
              onCreate={onCreateArticle ? value => onCreateArticle(item, value) : undefined} /> : null}
            <details className="quote-autopilot__more">
              <summary>{copy.details}</summary>
              <div className="quote-autopilot__body">
                <time dateTime={new Date(item.createdAt * 1000).toISOString()}>{new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(item.createdAt * 1000)}</time>
                <ul>{item.reasons.map(reason => <li key={reason}>{autopilotReviewReason(reason, language)}</li>)}</ul>
                {item.reasons.includes('missing_article') && onCatalogue && <p className="quote-autopilot__catalogue-hint">{catalogue.hint}</p>}
                {item.usualRequested && <p className="quote-autopilot__catalogue-hint">{catalogue.usual}</p>}
                <ol className="quote-autopilot__steps" aria-label={copy.request}>
                  <li data-state={linksDone || quote ? 'done' : 'current'}><span>1</span>{missing.length ? copy.stepLink : copy.stepNothingMissing}</li>
                  <li data-state={quote ? 'done' : linksDone && canQuote ? 'current' : 'next'}><span>2</span>{copy.stepQuote}</li>
                  <li data-state={quote ? 'current' : 'next'}><span>3</span>{copy.stepSendNow}</li>
                </ol>
                <div className="quote-autopilot__request-actions">
                  {quote && onOpenCreatedQuote && <button type="button" disabled={opening !== null} onClick={() => onOpenCreatedQuote(item)}>{copy.openQuote}</button>}
                  {item.reasons.includes('missing_article') && onCatalogue && <>
                    <button type="button" disabled={opening !== null} onClick={() => onCatalogue(item, 'browse')}>{catalogue.browse}</button>
                    {canAddCatalogue && <button type="button" disabled={opening !== null} onClick={() => onCatalogue(item, 'create')}>{catalogue.add}</button>}
                  </>}
                  <button type="button" className="quote-autopilot__source-action" disabled={opening !== null} onClick={() => { void open(item.proposalId, item.sourceId); }}>
                    {copy.openRequest}<ArrowUpRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </details>
          </li>;
        })())}</ol>}
    {readable && <AutopilotActionList summary={followUpSummary} cards={followUps} disabled={opening !== null} onAction={onFollowUp} label={copy.followUpListTitle} />}
    {readable && <AutopilotSignals cards={signals} disabled={opening !== null} onAct={onSignal} onIgnore={onIgnoreSignal} />}
    {readable && (choiceCards.length > 0 || acceptedCards.length > 0) && <ol className="quote-autopilot__requests quote-autopilot__requests--acceptances" aria-label={copy.acceptanceListTitle}>
      {choiceCards.map(card => <AcceptanceChoice key={card.key} card={card} disabled={opening !== null} onChoose={onChooseAcceptance} />)}
      {acceptedCards.map(card => { const key = { proposalId: card.key }; return <AcceptedRequest key={card.key} quote={createdQuote!(key)!} disabled={opening !== null}
        onCreate={onCreateInvoice ? () => onCreateInvoice(key) : undefined} onSend={onSendInvoice ? () => onSendInvoice(key) : undefined}
        onOpen={onOpenInvoice ? () => onOpenInvoice(key) : undefined} />; })}
    </ol>}
    {openFailed && <p className="quote-autopilot__error" role="status">{copy.openError}</p>}
    {state.error === 'busy' && <p className="quote-autopilot__context" role="status">{copy.busy}</p>}
    {readable && page.nextCursor && onNext && <footer><button type="button" disabled={state.readingReviews} onClick={() => { void onNext(); }}>{copy.more}<ChevronRight size={16} aria-hidden="true" /></button></footer>}
  </section>
  {readable && finished.length > 0 && <section className="quote-autopilot quote-autopilot--done" aria-labelledby="quote-autopilot-done-title">
    <header><div><h2 id="quote-autopilot-done-title">{copy.doneTitle}</h2><p>{copy.doneDescription}</p></div></header>
    <ol className="quote-autopilot__requests quote-autopilot__requests--done">{finished.map(item => { const quote = sentOf(item)!; return <li key={item.proposalId} data-state="done">
      <Check size={21} aria-hidden="true" />
      <div><strong>{quote.invoiceSentAt ? (quote.invoice?.number ? copy.doneInvoice.replace('{number}', quote.invoice.number) : copy.doneInvoiceDraft)
          : quote.number ? copy.doneQuote.replace('{number}', quote.number) : copy.doneQuoteDraft}</strong>
        <time dateTime={new Date(quote.invoiceSentAt ?? quote.sentAt!).toISOString()}>{new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(quote.invoiceSentAt ?? quote.sentAt!)}</time>
        <p className="quote-autopilot__done-summary">{quote.clientName ? copy.doneSentTo.replace('{client}', quote.clientName) : copy.doneSent}</p></div>
      <div className="quote-autopilot__request-actions">
        {quote.invoiceSentAt && onOpenInvoice && <button type="button" onClick={() => onOpenInvoice(item)}>{copy.openInvoice}</button>}
        {onOpenCreatedQuote && <button type="button" onClick={() => onOpenCreatedQuote(item)}>{copy.openQuote}</button>}
      </div>
    </li>; })}</ol>
  </section>}
  </>;
}

export function AutopilotCatalogueNext({ canWrite, onWriteQuote, onReturnRequest, onDismiss }: {
  canWrite: boolean; onWriteQuote: () => void; onReturnRequest: () => Promise<unknown>; onDismiss: () => void;
}) {
  const language = useAppLanguage(), copy = autopilotCatalogueCopy(language), common = autopilotCopy(language);
  const [opening, setOpening] = useState(false), [failed, setFailed] = useState(false);
  return <section className="quote-autopilot quote-autopilot--catalogue-next" aria-label={copy.saved}>
    <div><h2>{copy.saved}</h2><p>{copy.savedDetail}</p></div>
    <div className="quote-autopilot__next-actions">
      {canWrite && <button type="button" disabled={opening} onClick={onWriteQuote}>{copy.writeQuote}</button>}
      <button type="button" disabled={opening} onClick={() => { setOpening(true); setFailed(false);
        void onReturnRequest().catch(() => setFailed(true)).finally(() => setOpening(false)); }}>{copy.returnRequest}<ArrowUpRight size={16} aria-hidden="true" /></button>
      <button type="button" className="quote-autopilot__source-action" disabled={opening} onClick={onDismiss}>{copy.dismiss}</button>
    </div>
    {failed && <p role="status" className="quote-autopilot__error">{common.openError}</p>}
  </section>;
}
