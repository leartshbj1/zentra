import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { parseBudgetAmount } from './budget';
import { t, useAppLanguage } from './language';
import { OPEN_STAGES, nextStage, pipelineRows, pipelineSummary, type Opportunity, type OpportunityStage, type PipelineRow } from './pipeline';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatDate, formatMoney, todayIso } from './utils';
import './erp-registers.css';

const STAGE_LABEL: Record<OpportunityStage, string> = { lead: 'Nouvelle demande', contact: 'En discussion', quote: 'Devis envoyé', won: 'Gagnée', lost: 'Perdue' };
type Draft = { id: string | null; clientId: string; prospectName: string; title: string; amount: string; stage: OpportunityStage; expectedCloseDate: string; notes: string; lostReason: string; quoteId: string | null };

/** Opportunités : de la première demande au devis, avec la prévision pondérée. */
export function PipelinePanel({ workspace, readOnly, onWorkspace, onCreateQuote, onOpenQuote }: {
  workspace: Workspace; readOnly: boolean; onWorkspace: (workspace: Workspace) => void;
  onCreateQuote: (opportunity: Opportunity) => void; onOpenQuote: (quoteId: string) => void;
}) {
  useAppLanguage();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => pipelineRows(workspace.opportunities ?? [], workspace.quotes), [workspace.opportunities, workspace.quotes]);
  const summary = pipelineSummary(rows, todayIso().slice(0, 4));
  const clients = workspace.clients.filter(client => !client.archivedAt);
  const party = (row: PipelineRow) => { const client = workspace.clients.find(item => item.id === row.opportunity.clientId); return client?.company || client?.name || row.opportunity.prospectName; };
  const amount = draft ? parseBudgetAmount(draft.amount) : null;
  const valid = !!draft && !!draft.title.trim() && amount !== null && (!!draft.clientId || !!draft.prospectName.trim());

  async function save(next: Omit<Opportunity, 'id' | 'stageChangedAt' | 'createdAt' | 'updatedAt'> & { id: string | null }, done: string) {
    setBusy(true);
    setMessage('');
    try {
      const result = await desktopApi.saveOpportunity(next);
      onWorkspace(result.workspace);
      setMessage(done);
      return result.id;
    } catch (reason) {
      setMessage(errorMessage(reason, t('L’opportunité n’a pas pu être enregistrée.')));
      return null;
    } finally {
      setBusy(false);
    }
  }
  const fromOpportunity = (opportunity: Opportunity, patch: Partial<Opportunity>) => ({
    id: opportunity.id, clientId: opportunity.clientId, prospectName: opportunity.prospectName, title: opportunity.title, stage: opportunity.stage, amountCents: opportunity.amountCents,
    expectedCloseDate: opportunity.expectedCloseDate, quoteId: opportunity.quoteId, notes: opportunity.notes, lostReason: opportunity.lostReason, ...patch,
  });
  async function submit() {
    if (!draft || !valid || amount === null) return;
    const saved = await save({ id: draft.id, clientId: draft.clientId || null, prospectName: draft.clientId ? '' : draft.prospectName.trim(), title: draft.title.trim(), stage: draft.stage,
      amountCents: amount, expectedCloseDate: draft.expectedCloseDate || null, quoteId: draft.quoteId, notes: draft.notes, lostReason: draft.lostReason }, t('Opportunité enregistrée.'));
    if (saved) setDraft(null);
  }
  const edit = (opportunity?: Opportunity) => setDraft(opportunity
    ? { id: opportunity.id, clientId: opportunity.clientId ?? '', prospectName: opportunity.prospectName, title: opportunity.title, amount: (opportunity.amountCents / 100).toFixed(2), stage: opportunity.stage,
      expectedCloseDate: opportunity.expectedCloseDate ?? '', notes: opportunity.notes, lostReason: opportunity.lostReason, quoteId: opportunity.quoteId }
    : { id: null, clientId: '', prospectName: '', title: '', amount: '', stage: 'lead', expectedCloseDate: '', notes: '', lostReason: '', quoteId: null });

  const item = (row: PipelineRow) => {
    const { opportunity } = row;
    const next = nextStage(row.stage);
    return <li key={opportunity.id}>
      <span>
        <strong>{opportunity.title}</strong>
        <small>{[party(row), formatMoney(row.amountCents), opportunity.expectedCloseDate ? t('prévue le {date}', { date: formatDate(opportunity.expectedCloseDate) }) : ''].filter(Boolean).join(' · ')}</small>
        {opportunity.notes ? <small>{opportunity.notes}</small> : null}
      </span>
      <span />
      {readOnly ? null : <span className="erp-register__links">
        {opportunity.quoteId && workspace.quotes.some(quote => quote.id === opportunity.quoteId)
          ? <button type="button" disabled={busy} onClick={() => onOpenQuote(opportunity.quoteId!)}>{t('Ouvrir le devis')}</button>
          : row.stage !== 'won' && row.stage !== 'lost' ? <button type="button" disabled={busy} onClick={() => onCreateQuote(opportunity)}>{t('Créer le devis')}</button> : null}
        {next && next !== 'quote' ? <button type="button" disabled={busy} onClick={() => void save(fromOpportunity(opportunity, { stage: next }), t('Opportunité passée à « {stage} ».', { stage: t(STAGE_LABEL[next]) }))}>{t('Passer à « {stage} »', { stage: t(STAGE_LABEL[next]) })}</button> : null}
        {(OPEN_STAGES as readonly string[]).includes(row.stage) ? <button type="button" disabled={busy} onClick={() => void save(fromOpportunity(opportunity, { stage: 'lost' }), t('Opportunité marquée perdue.'))}>{t('Perdue')}</button> : null}
        <button type="button" disabled={busy || !!draft} onClick={() => edit(opportunity)}>{t('Modifier')}</button>
      </span>}
    </li>;
  };
  const closed = rows.filter(row => row.stage === 'won' || row.stage === 'lost');

  return <section className="erp-register" aria-labelledby="pipeline-title">
    <h2 id="pipeline-title">{t('Pipeline des ventes')}</h2>
    <p>{t('Suivez chaque affaire de la première demande au devis. Quand un devis est lié, son état fait foi : accepté, l’opportunité est gagnée ; refusé ou expiré, elle est perdue.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Notez la demande avec un montant estimé hors TVA et, si vous la connaissez, la date de décision prévue.')}</li>
        <li>{t('« Créer le devis » ouvre le devis prérempli ; il reste lié à l’opportunité.')}</li>
        <li>{t('La prévision pondère chaque montant par l’étape : 10 % pour une demande, 30 % en discussion, 60 % avec un devis envoyé.')}</li>
      </ol>
    </details>
    <dl className="erp-register__horizons">
      <div><dt>{t('En cours')}</dt><dd>{formatMoney(summary.openCents)}</dd><dd className="erp-register__note">{t('{n} opportunité(s)', { n: summary.open })}</dd></div>
      <div><dt>{t('Prévision pondérée')}</dt><dd>{formatMoney(summary.weightedCents)}</dd></div>
      <div><dt>{t('Gagnées en {year}', { year: todayIso().slice(0, 4) })}</dt><dd>{formatMoney(summary.wonCents)}</dd>{summary.lostCount ? <dd className="erp-register__note">{t('{n} perdue(s)', { n: summary.lostCount })}</dd> : null}</div>
    </dl>
    {message ? <p role="status">{message}</p> : null}
    {draft ? <div className="erp-register__form">
      <Field label={t('Client')}><select value={draft.clientId} disabled={busy} onChange={event => setDraft({ ...draft, clientId: event.target.value })}>
        <option value="">{t('Nouveau prospect')}</option>
        {clients.map(client => <option key={client.id} value={client.id}>{client.company || client.name}</option>)}
      </select></Field>
      {draft.clientId ? null : <Field label={t('Nom du prospect')}><input value={draft.prospectName} maxLength={200} disabled={busy} onChange={event => setDraft({ ...draft, prospectName: event.target.value })} /></Field>}
      <div className="erp-register__wide"><Field label={t('Affaire')}><input value={draft.title} maxLength={200} placeholder={t('Rénovation de la cuisine')} disabled={busy} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field></div>
      <Field label={t('Montant estimé hors TVA, CHF')}><input inputMode="decimal" value={draft.amount} placeholder="0.00" disabled={busy} aria-invalid={amount === null} onChange={event => setDraft({ ...draft, amount: event.target.value })} /></Field>
      <Field label={t('Étape')}><select value={draft.stage} disabled={busy || !!draft.quoteId} onChange={event => setDraft({ ...draft, stage: event.target.value as OpportunityStage })}>
        {(['lead', 'contact', 'quote', 'won', 'lost'] as const).map(stage => <option key={stage} value={stage}>{t(STAGE_LABEL[stage])}</option>)}
      </select></Field>
      <Field label={t('Décision prévue le')}><input type="date" value={draft.expectedCloseDate} disabled={busy} onChange={event => setDraft({ ...draft, expectedCloseDate: event.target.value })} /></Field>
      <div className="erp-register__wide"><Field label={t('Notes')}><textarea rows={2} maxLength={4000} value={draft.notes} disabled={busy} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></Field></div>
      {draft.stage === 'lost' ? <div className="erp-register__wide"><Field label={t('Raison de la perte')}><input maxLength={500} value={draft.lostReason} disabled={busy} onChange={event => setDraft({ ...draft, lostReason: event.target.value })} /></Field></div> : null}
      <div className="erp-register__actions">
        <Button type="button" disabled={busy || !valid} onClick={() => void submit()}>{busy ? t('Enregistrement…') : t('Enregistrer l’opportunité')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div> : <div className="erp-register__actions"><Button type="button" disabled={readOnly || busy} onClick={() => edit()}>{t('Nouvelle opportunité')}</Button></div>}
    <div className="erp-register__columns">
      {OPEN_STAGES.map(stage => {
        const stageRows = rows.filter(row => row.stage === stage);
        return <section key={stage} aria-labelledby={`pipeline-${stage}`}>
          <h3 id={`pipeline-${stage}`}>{t(STAGE_LABEL[stage])}</h3>
          <p>{t('{n} · {amount}', { n: stageRows.length, amount: formatMoney(stageRows.reduce((sum, row) => sum + row.amountCents, 0)) })}</p>
          {stageRows.length ? <ul className="erp-register__list">{stageRows.map(item)}</ul> : <p>{t('Rien pour le moment.')}</p>}
        </section>;
      })}
    </div>
    {closed.length ? <details>
      <summary>{t('Gagnées et perdues ({n})', { n: closed.length })}</summary>
      <ul className="erp-register__list">{closed.map(row => <li key={row.opportunity.id}>
        <span><strong>{row.opportunity.title}</strong><small>{[party(row), t(STAGE_LABEL[row.stage]), formatMoney(row.amountCents), row.opportunity.lostReason].filter(Boolean).join(' · ')}</small></span>
        <span />
      </li>)}</ul>
    </details> : null}
  </section>;
}
