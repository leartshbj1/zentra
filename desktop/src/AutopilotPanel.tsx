import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, ClipboardCheck, Workflow } from 'lucide-react';
import { useAppLanguage, getAppLocale } from './language';
import { autopilotCopy, autopilotCatalogueCopy, autopilotReviewReason } from './autopilotPresentation';
import { normalizeAutopilotReviewPage, type AutopilotReviewItem } from './autopilotReview';
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
function UnmatchedLine({ phrase, catalogue, disabled, onChoose, onCreate }: {
  phrase: string; catalogue: readonly Readonly<{ id: string; name: string }>[]; disabled: boolean;
  onChoose?: (phrase: string, articleId: string) => Promise<string>; onCreate?: (phrase: string) => void;
}) {
  const copy = autopilotCopy(useAppLanguage());
  const [saving, setSaving] = useState(false), [term, setTerm] = useState(''), [failed, setFailed] = useState(false);
  const choose = async (articleId: string) => {
    if (!articleId || !onChoose || saving) return;
    setSaving(true); setFailed(false);
    try { setTerm(await onChoose(phrase, articleId)); } catch { setFailed(true); } finally { setSaving(false); }
  };
  return <li>
    <q>{phrase}</q>
    <div className="quote-autopilot__unmatched-actions">
      {onChoose && <select aria-label={copy.chooseArticle} disabled={disabled || saving} value="" onChange={event => { void choose(event.target.value); }}>
        <option value="">{copy.chooseArticle}</option>
        {catalogue.map(article => <option key={article.id} value={article.id}>{article.name}</option>)}
      </select>}
      {onCreate && <button type="button" disabled={disabled || saving} onClick={() => onCreate(phrase)}>{copy.createArticle}</button>}
    </div>
    {term && <p className="quote-autopilot__remembered" role="status">{copy.remembered.replace('{term}', term)}</p>}
    {failed && <p className="quote-autopilot__error" role="status">{copy.chooseError}</p>}
  </li>;
}

export function AutopilotReviews({ state, organizationId, onOpenSource, onNext, onRefresh, onCatalogue, canAddCatalogue = false, onCreateQuote, catalogueArticles = [], onChooseArticle, onCreateArticle }: {
  state: AutopilotView; organizationId: string; onOpenSource: (sourceId: string) => Promise<unknown>;
  onNext?: () => Promise<void>; onRefresh?: () => Promise<void>;
  onCatalogue?: (item: Pick<AutopilotReviewItem, 'proposalId' | 'sourceId'>, mode: 'browse' | 'create') => void;
  canAddCatalogue?: boolean;
  /** Opens the ordinary quote form filled from the suggestion; the person saves it. */
  onCreateQuote?: (item: AutopilotReviewItem) => void;
  /** Local catalogue offered for request lines without an article. */
  catalogueArticles?: readonly Readonly<{ id: string; name: string }>[];
  /** Saves "this wording means this article"; resolves with the remembered wording. */
  onChooseArticle?: (phrase: string, articleId: string) => Promise<string>;
  /** Opens the article form filled with the request line; the choice is saved after creation. */
  onCreateArticle?: (item: AutopilotReviewItem, phrase: string) => void;
}) {
  const language = useAppLanguage(), copy = autopilotCopy(language), catalogue = autopilotCatalogueCopy(language);
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
  return <section className="quote-autopilot quote-autopilot--reviews" aria-labelledby="quote-autopilot-review-title">
    <header><div><h2 id="quote-autopilot-review-title">{copy.reviewTitle}</h2><p>{copy.reviewDescription}</p></div>
      {onRefresh && <button type="button" disabled={state.readingReviews} onClick={() => { void onRefresh(); }}>{copy.refresh}</button>}
    </header>
    {!readable ? <p className="quote-autopilot__context" role="status">{state.status !== 'ready' ? statusText(state, language) : state.readingReviews ? copy.loading : copy.readError}</p>
      : page.items.length === 0 ? <p className="quote-autopilot__context">{copy.empty}</p>
        : <ol className="quote-autopilot__requests">{page.items.map(item => <li key={item.proposalId}>
          <ClipboardCheck size={21} aria-hidden="true" />
          <div><strong>{item.reasons.includes('missing_article') ? catalogue.title : copy.request}</strong><time dateTime={new Date(item.createdAt * 1000).toISOString()}>
            {new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(item.createdAt * 1000)}
          </time><ul>{item.reasons.map(reason => <li key={reason}>{autopilotReviewReason(reason, language)}</li>)}</ul>
          {item.reasons.includes('missing_article') && onCatalogue && <p className="quote-autopilot__catalogue-hint">{catalogue.hint}</p>}
          {item.usualRequested && <p className="quote-autopilot__catalogue-hint">{catalogue.usual}</p>}
          {onCreateQuote && item.suggestion?.lines.length ? <p className="quote-autopilot__catalogue-hint">{copy.createQuoteHint}</p> : null}
          {item.suggestion?.unmatched?.length && (onChooseArticle || onCreateArticle) ? <div className="quote-autopilot__unmatched">
            <strong>{copy.unmatchedTitle}</strong>
            <ul>{item.suggestion.unmatched.map(phrase => <UnmatchedLine key={phrase} phrase={phrase} catalogue={catalogueArticles}
              disabled={opening !== null} onChoose={onChooseArticle} onCreate={onCreateArticle ? value => onCreateArticle(item, value) : undefined} />)}</ul>
          </div> : null}</div>
          <div className="quote-autopilot__request-actions">
          {onCreateQuote && item.suggestion?.lines.length ? <button type="button" className="quote-autopilot__create-quote" disabled={opening !== null} onClick={() => onCreateQuote(item)}>{copy.createQuote}</button> : null}
          {item.reasons.includes('missing_article') && onCatalogue && <>
            <button type="button" disabled={opening !== null} onClick={() => onCatalogue(item, 'browse')}>{catalogue.browse}</button>
            {canAddCatalogue && <button type="button" disabled={opening !== null} onClick={() => onCatalogue(item, 'create')}>{catalogue.add}</button>}
          </>}
          <button type="button" className="quote-autopilot__source-action" disabled={opening !== null} onClick={() => { void open(item.proposalId, item.sourceId); }}>
            {copy.openRequest}<ArrowUpRight size={16} aria-hidden="true" />
          </button></div>
        </li>)}</ol>}
    {openFailed && <p className="quote-autopilot__error" role="status">{copy.openError}</p>}
    {state.error === 'busy' && <p className="quote-autopilot__context" role="status">{copy.busy}</p>}
    {readable && page.nextCursor && onNext && <footer><button type="button" disabled={state.readingReviews} onClick={() => { void onNext(); }}>{copy.more}<ChevronRight size={16} aria-hidden="true" /></button></footer>}
  </section>;
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
