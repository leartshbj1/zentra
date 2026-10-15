import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Download, FileCheck2, Fingerprint, LockKeyhole, PackageCheck, Scale } from 'lucide-react';
import { desktopApi } from './bridge';
import { isMobileRuntime } from './mobileRuntime';
import type { AccountingPeriod, FiduciaryClosingReview, FiduciaryPackageExport, PeriodFilter, TrialBalanceReport } from './types';
import { buildClosingChecks, closingReadiness, type ComparativeBalanceSheet, type ComparativeIncomeStatement } from './accountingClosure';
import { errorMessage, formatDate, formatMoney } from './utils';
import { Button, EmptyState, ErrorPanel, Field, Modal, SectionHeading } from './ui';
import { getAppLanguage, t, useAppLanguage } from './language';
import './ClosingFolder.css';

/** Places a styled value inside a translated sentence, so each language keeps its own word order. */
function withSlot(text: string, slot: string, node: ReactNode): ReactNode {
  const marker = `{${slot}}`, index = text.indexOf(marker);
  if (index < 0) return text;
  return <>{text.slice(0, index)}{node}{text.slice(index + marker.length)}</>;
}

// These words already exist as interface keys with another meaning ('Actifs' = active filter,
// 'Produits' = catalogue products, 'Précédent' = back button). Statements need their accounting sense.
const statementTerms = {
  Actifs: { de: 'Aktiven', it: 'Attivi', en: 'Assets' },
  Produits: { de: 'Erträge', it: 'Ricavi', en: 'Revenue' },
  Précédent: { de: 'Vorperiode', it: 'Precedente', en: 'Previous' },
} as const;
function statementTerm(source: keyof typeof statementTerms): string {
  const language = getAppLanguage();
  return language === 'fr' ? source : statementTerms[source][language];
}

export function ClosingFolder({
  filter,
  workspaceScope,
  period,
  trial,
  balance,
  income,
  loading = false,
  readOnly = false,
  onNavigate,
  onAccountingChanged,
}: {
  filter: PeriodFilter;
  workspaceScope?: string;
  period?: AccountingPeriod;
  trial: TrialBalanceReport | null;
  balance: ComparativeBalanceSheet | null;
  income: ComparativeIncomeStatement | null;
  loading?: boolean;
  readOnly?: boolean;
  onNavigate?: (target: 'periods' | 'accounts' | 'journal') => void;
  onAccountingChanged?: () => Promise<void>;
}) {
  useAppLanguage();
  const [review, setReview] = useState<FiduciaryClosingReview | null>(null);
  const [exported, setExported] = useState<FiduciaryPackageExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const operation = useRef({ id: 0, busy: false, mounted: false });
  const checks = buildClosingChecks({ filter, period, trial, balance, income });
  const readiness = loading ? 'warning' : review && !review.checks.readyForFinal ? 'blocked' : closingReadiness(checks);
  const scope = balance?.scope ?? income?.scope;

  useLayoutEffect(() => {
    operation.current = { id: operation.current.id + 1, busy: false, mounted: true };
    setBusy(false);
    setReview(null);
    setExported(null);
    setConfirming(false);
    setConfirmation('');
    setError('');
    setNotice('');
    setNeedsRefresh(false);
    return () => { operation.current = { id: operation.current.id + 1, busy: false, mounted: false }; };
  }, [workspaceScope, filter.dateFrom, filter.dateTo, period?.id]);

  function startOperation() {
    if (!operation.current.mounted || loading || operation.current.busy) return null;
    const id = operation.current.id + 1;
    operation.current = { id, busy: true, mounted: true };
    setBusy(true);
    setError('');
    setNotice('');
    return id;
  }

  function finishOperation(id: number) {
    if (operation.current.id !== id) return;
    operation.current.busy = false;
    setBusy(false);
  }

  async function prepareReview() {
    if (needsRefresh || readOnly) return;
    const request = startOperation();
    if (request === null) return;
    setReview(null);
    setConfirming(false);
    setConfirmation('');
    try {
      const next = await desktopApi.prepareFiduciaryPreClosing(filter, workspaceScope);
      if (operation.current.id !== request) return;
      if (next.period.id !== period?.id || next.period.dateFrom !== filter.dateFrom || next.period.dateTo !== filter.dateTo) {
        throw new Error('Le contrôle reçu ne correspond pas à l’exercice sélectionné. Préparez-le à nouveau.');
      }
      setReview(next);
      setExported(null);
      setNotice(next.checks.readyForFinal
        ? next.period.status === 'closed'
          ? t('Le contrôle est prêt. Vous pouvez exporter le dossier définitif.')
          : t('Le contrôle est prêt. Exportez un dossier provisoire ou confirmez la clôture définitive.')
        : t('Le contrôle est enregistré. Corrigez les points signalés avant la clôture définitive.'));
    } catch (reason) {
      if (operation.current.id !== request) return;
      setError(errorMessage(reason, 'La pré-clôture n’a pas pu être préparée.'));
    } finally {
      finishOperation(request);
    }
  }

  async function finalizePeriod() {
    if (readOnly || !review || !review.checks.readyForFinal || review.period.status !== 'open' || review.period.id !== period?.id || needsRefresh) return;
    const targetPeriod = review.period;
    if (confirmation.trim() !== targetPeriod.name) {
      setError(t('Saisissez exactement « {name} » pour confirmer le verrouillage définitif.', { name: targetPeriod.name }));
      return;
    }
    const request = startOperation();
    if (request === null) return;
    try {
      const result = await desktopApi.finalizeAccountingPeriodWithReview(targetPeriod.id, review.reviewId, workspaceScope);
      if (operation.current.id !== request) return;
      setReview((current) => current ? { ...current, period: result.period, packageStatusIfExported: 'FINAL' } : current);
      setConfirming(false);
      setConfirmation('');
      setNotice(t('L’exercice est clôturé. Vous pouvez maintenant exporter le dossier définitif.'));
    } catch (reason) {
      if (operation.current.id !== request) return;
      setError(errorMessage(reason, 'La clôture définitive a été refusée. Préparez un nouveau contrôle si les données ont changé.'));
      finishOperation(request);
      return;
    }
    try {
      await onAccountingChanged?.();
    } catch (reason) {
      if (operation.current.id !== request) return;
      const detail = errorMessage(reason, t('Erreur locale non détaillée.'));
      setNeedsRefresh(true);
      setError(t('La période est bien verrouillée, mais les états affichés n’ont pas pu être actualisés. Actualisez les états avant de continuer. {detail}', { detail }));
    } finally {
      finishOperation(request);
    }
  }

  async function exportPackage() {
    if (!review || review.period.id !== period?.id || needsRefresh) return;
    const request = startOperation();
    if (request === null) return;
    try {
      const result = await desktopApi.exportFiduciaryClosingZip(review.reviewId, workspaceScope, () => operation.current.mounted && operation.current.id === request);
      if (operation.current.id !== request) return;
      setExported(result);
      setReview(null);
      setNotice(result.packageStatus === 'FINAL'
        ? t('Dossier définitif enregistré : {fileName}', { fileName: result.fileName })
        : t('Dossier provisoire enregistré : {fileName}', { fileName: result.fileName }));
      if (result.deliveryWarning) setError(result.deliveryWarning);
    } catch (reason) {
      if (operation.current.id !== request) return;
      setError(errorMessage(reason, 'Le dossier fiduciaire n’a pas pu être exporté.'));
    } finally {
      finishOperation(request);
    }
  }

  async function refreshClosedPeriod() {
    const request = startOperation();
    if (request === null) return;
    try {
      await onAccountingChanged?.();
      if (operation.current.id !== request) return;
      setNeedsRefresh(false);
      setNotice(t('Les états de l’exercice clôturé ont été actualisés. Vous pouvez exporter le dossier définitif.'));
    } catch (reason) {
      if (operation.current.id !== request) return;
      setError(errorMessage(reason, 'Les états n’ont pas pu être actualisés. L’exercice reste clôturé.'));
    } finally {
      finishOperation(request);
    }
  }

  async function sharePackage() {
    if (!exported) return;
    const request = startOperation();
    if (request === null) return;
    try {
      await desktopApi.shareExistingExport(exported.path);
      if (operation.current.id !== request) return;
      setExported((current) => current ? { ...current, deliveryWarning: undefined } : null);
      setNotice(t('Le dossier existant a été proposé au partage.'));
    } catch (reason) {
      if (operation.current.id !== request) return;
      setError(errorMessage(reason, 'Le partage n’a pas abouti. Le dossier exporté est conservé sur cet appareil.'));
    } finally {
      finishOperation(request);
    }
  }

  if (!filter.dateFrom || !filter.dateTo) {
    return <section className="panel closing-folder"><EmptyState icon={<FileCheck2 />} title={t('Choisissez un exercice')} text={t('Ouvrez un exercice enregistré, ou créez-le en indiquant ses dates. Vous pourrez ensuite préparer les contrôles et exporter le dossier.')} />{onNavigate && <Button disabled={loading || busy} onClick={() => onNavigate('periods')}>{t('Choisir ou créer un exercice')}</Button>}</section>;
  }

  return <section className="panel closing-folder" aria-busy={busy || loading}>
    <SectionHeading
      eyebrow={period?.status === 'closed' ? t('Dossier verrouillé') : t('Dossier de travail')}
      title={t('Dossier de clôture')}
      description={t('Vérifiez votre exercice, exportez un dossier provisoire, puis clôturez lorsque tout est prêt.')}
    />

    <div className={`closing-readiness is-${readiness}`}>
      {readiness === 'ready' ? <CheckCircle2 size={22} /> : readiness === 'blocked' ? <AlertTriangle size={22} /> : <CircleDashed size={22} />}
      <div>
        <strong>{loading ? t('Actualisation des états') : readiness === 'ready' ? t('Contrôles prêts') : readiness === 'blocked' ? t('Points à vérifier') : t('Dossier encore provisoire')}</strong>
        <p>{loading ? t('Les montants de l’exercice sélectionné sont en cours de chargement.') : readiness === 'ready' ? t('Les contrôles automatiques sont satisfaits.') : t('Préparez le contrôle pour vérifier les écritures et les pièces avant la clôture.')}</p>
      </div>
    </div>

    <section className="closing-workflow" aria-labelledby="closing-workflow-title">
      <header>
        <div><span>{t('Clôture de l’exercice')}</span><h3 id="closing-workflow-title">{t('Préparer le dossier')}</h3><p>{t('Vérifiez les écritures et les pièces. Toute modification des données impose un nouveau contrôle avant la clôture.')}</p></div>
        <Button disabled={busy || loading || readOnly || needsRefresh || !period || !filter.dateFrom || !filter.dateTo} onClick={() => void prepareReview()}><Fingerprint size={16} /> {review ? t('Repréparer le contrôle') : t('Préparer le contrôle')}</Button>
      </header>
      {!period ? <div className="closing-inline-warning"><AlertTriangle size={18} /><p>{t('Ces dates ne correspondent pas à un exercice sélectionné. Ouvrez ou créez un exercice pour préparer le contrôle.')}</p>{onNavigate && <Button disabled={busy || loading} onClick={() => onNavigate('periods')}>{t('Choisir ou créer un exercice')}</Button>}</div> : null}
      {readOnly && <p className="closing-inline-warning">{t('La préparation d’un contrôle et la clôture nécessitent l’accès en modification. Les états et le partage d’un dossier déjà exporté restent consultables.')}</p>}
      {error && !confirming ? <ErrorPanel message={error} reveal /> : null}
      {needsRefresh ? <Button variant="secondary" disabled={busy || loading} onClick={() => void refreshClosedPeriod()}>{t('Actualiser les états')}</Button> : null}
      {notice ? <div className="notice notice--success" role="status" aria-live="polite"><CheckCircle2 size={17} />{notice}</div> : null}
      {review ? <div className="closing-review-card">
        <div className="closing-review-head"><div><span>{review.checks.readyForFinal ? t('Contrôle prêt') : t('Contrôle à corriger')}</span><strong>{review.period.name}</strong><small>{t('Empreinte {hash}…', { hash: review.sourceSha256.slice(0, 16) })} · {journalEntryCount(review.summary.journalEntries)} · {attachmentProgress(review.checks.attachmentsVerified, review.checks.attachmentsTotal)}</small></div><span className={`closing-review-badge ${review.checks.readyForFinal ? 'is-ready' : 'is-blocked'}`}>{review.checks.readyForFinal ? t('Prêt pour décision') : t('Bloqué')}</span></div>
        <ClosingReviewChecks review={review} />
        {onNavigate && (review.checks.continuity.totalAnomalies > 0 || !review.checks.journalBalanced || !review.checks.balanceSheetBalanced) && <div className="closing-review-actions">{review.checks.continuity.totalAnomalies > 0 && <Button variant="secondary" disabled={busy || loading || needsRefresh} onClick={() => onNavigate('accounts')}>{t('Vérifier les comptes et les opérations manquantes')}</Button>}{(!review.checks.journalBalanced || !review.checks.balanceSheetBalanced) && <Button variant="secondary" disabled={busy || loading || needsRefresh} onClick={() => onNavigate('journal')}>{t('Examiner le journal')}</Button>}</div>}
        <div className="closing-review-actions">
          <Button variant="secondary" disabled={busy || loading || needsRefresh} onClick={() => void exportPackage()}><Download size={16} /> {review.period.status === 'closed' || review.packageStatusIfExported === 'FINAL' ? t('Exporter le dossier définitif') : t('Exporter un dossier provisoire')}</Button>
          {review.period.status === 'open' && review.checks.readyForFinal ? <Button disabled={busy || loading || readOnly || needsRefresh} onClick={() => setConfirming(true)}><LockKeyhole size={16} /> {t('Clôturer définitivement')}</Button> : null}
        </div>
        {confirming ? <Modal title={t('Clôturer cet exercice')} onClose={() => { setConfirming(false); setConfirmation(''); setError(''); }} dismissible={!busy && !loading} className="closing-confirmation-modal"><form className="closing-confirmation" onSubmit={event => { event.preventDefault(); void finalizePeriod(); }}>
          <div className="closing-confirmation__period"><strong>{review.period.name}</strong><p>{formatDate(review.period.dateFrom)} → {formatDate(review.period.dateTo)}</p></div>
          <p id="closing-confirmation-help" className="closing-confirmation__effect">{withSlot(t('Cette action verrouille définitivement les comptes jusqu’au {date}, y compris les dates antérieures au début de cet exercice. Vous ne pourrez plus ajouter d’écriture à ces dates. Vérifiez aussi votre historique avant de continuer.'), 'date', <strong>{t('{date} inclus', { date: formatDate(review.period.dateTo) })}</strong>)}</p>
          {error && <ErrorPanel title="Vérifions ce point" message={error} reveal />}
          <Field label={t('Recopiez « {name} » pour confirmer', { name: review.period.name })}><input value={confirmation} disabled={busy || loading || readOnly} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="closing-confirmation-help" autoComplete="off" spellCheck={false} /></Field>
          {readOnly && <p>{t('La clôture est indisponible en lecture seule.')}</p>}
          {error && <Button type="button" variant="secondary" disabled={busy || loading || readOnly} onClick={() => void prepareReview()}>{t('Refaire le contrôle')}</Button>}
          <details><summary>{t('Faire vérifier le dossier avant de décider')}</summary><p>{t('Annulez cette confirmation et choisissez « Exporter un dossier provisoire ». Vous pourrez le faire contrôler avant de clôturer.')}</p></details>
          <div className="form-actions"><Button type="button" variant="secondary" disabled={busy || loading} onClick={() => { setConfirming(false); setConfirmation(''); setError(''); }}>{t('Annuler')}</Button><Button type="submit" disabled={busy || loading || readOnly || confirmation.trim() !== review.period.name}><LockKeyhole size={15} /> {busy ? t('Clôture en cours…') : t('Verrouiller l’exercice')}</Button></div>
        </form></Modal> : null}
      </div> : null}
      {exported ? <div className="closing-export-card"><PackageCheck size={20} /><div><strong>{exported.packageStatus === 'FINAL' ? t('Dossier définitif exporté') : t('Dossier provisoire exporté')}</strong><p>{exported.fileName} · {t('{count} fichiers', { count: exported.fileCount })}</p><small>{exported.path}</small><details><summary>{t('Vérification du dossier')}</summary><small>{t('Empreinte du manifeste : {hash}', { hash: exported.manifestSha256 })}</small></details>{isMobileRuntime() || exported.deliveryWarning ? <Button variant="secondary" disabled={busy || loading} onClick={() => void sharePackage()}>{t('Partager le dossier')}</Button> : null}</div></div> : null}
    </section>

    <details className="closing-details">
    <summary>{t('Bilan, résultat et contrôles détaillés')}</summary>
    <div className="closing-period-grid">
      <article><span>{t('Exercice sous revue')}</span><strong>{formatDate(filter.dateFrom)} → {formatDate(filter.dateTo)}</strong><small>{period?.name ?? t('Période libre explicitement datée')}</small></article>
      <article><span>{t('Comparatif')}</span><strong>{scope ? `${formatDate(scope.previousDateFrom)} → ${formatDate(scope.previousDateTo)}` : '—'}</strong><small>{scope?.comparisonLabel ?? t('Calcul en attente')}</small></article>
      <article><span>{t('Monnaie de présentation')}</span><strong>{balance?.currency.baseCurrency ?? income?.currency.baseCurrency ?? '—'}</strong><small>{t('Les états conservent leur monnaie comptable')}</small></article>
    </div>

    <div className="closing-comparison-grid">
      <StatementComparison
        title={t('Bilan')}
        icon={<Scale size={18} />}
        currentLabel={formatDate(filter.dateTo)}
        previousLabel={formatDate(scope?.previousDateTo)}
        rows={[
          [statementTerm('Actifs'), balance?.assetsCents, balance?.previousAssetsCents],
          [t('Dettes'), balance?.liabilitiesCents, balance?.previousLiabilitiesCents],
          [t('Fonds propres'), balance?.equityCents, balance?.previousEquityCents],
          [t('Résultats antérieurs non affectés'), balance?.unallocatedPriorResultsCents, balance?.previousUnallocatedPriorResultsCents],
          [t('Résultat de l’exercice'), balance?.currentResultCents, balance?.previousCurrentResultCents],
        ]}
      />
      <StatementComparison
        title={t('Compte de résultat')}
        icon={<FileCheck2 size={18} />}
        currentLabel={`${formatDate(filter.dateFrom)} – ${formatDate(filter.dateTo)}`}
        previousLabel={scope ? `${formatDate(scope.previousDateFrom)} – ${formatDate(scope.previousDateTo)}` : '—'}
        rows={[
          [statementTerm('Produits'), income?.revenueCents, income?.previousRevenueCents],
          [t('Charges'), income?.expenseCents, income?.previousExpenseCents],
          [t('Bénéfice / perte'), income?.profitCents, income?.previousProfitCents],
        ]}
      />
    </div>

    <div className="closing-checks">
      {checks.map((check) => <article key={check.id} className={`is-${check.state}`}>
        {check.state === 'ready' ? <CheckCircle2 size={18} /> : check.state === 'blocked' ? <AlertTriangle size={18} /> : <CircleDashed size={18} />}
        {/* Fixed closing-rule copy is translated when displayed; dated details stay as provided. */}
        <div><strong>{t(check.label)}</strong><p>{t(check.detail)}</p></div>
      </article>)}
    </div>
    </details>

    <div className="closing-limitation">
      <LockKeyhole size={18} />
      <p><strong>{t('Pièces complémentaires.')}</strong> {t('L’annexe légale, les décisions d’approbation et, selon votre situation, la déclaration fiscale et le rapport de révision restent à établir séparément.')}</p>
    </div>
  </section>;
}

function journalEntryCount(count: number): string {
  return count > 1 ? t('{count} écritures', { count }) : t('{count} écriture', { count });
}

function attachmentProgress(verified: number, total: number): string {
  return total > 1 ? t('{verified}/{total} pièces vérifiées', { verified, total }) : t('{verified}/{total} pièce vérifiée', { verified, total });
}

function ClosingReviewChecks({ review }: { review: FiduciaryClosingReview }) {
  useAppLanguage();
  const attachmentsReady = (
    review.checks.attachmentsTotal === review.checks.attachmentsVerified &&
    review.checks.attachmentIssues.length === 0
  );
  const verified = review.checks.attachmentsVerified;
  const items: Array<[string, boolean, string]> = [
    [t('Journal'), review.checks.journalBalanced, review.checks.journalBalanced ? t('Toutes les écritures contrôlées sont équilibrées.') : t('Au moins une écriture ou la balance des comptes présente un écart.')],
    [t('Bilan'), review.checks.balanceSheetBalanced, review.checks.balanceSheetBalanced ? t('L’équation du bilan est satisfaite.') : t('Le bilan ne respecte pas encore son équation d’équilibre.')],
    [t('Journal d’audit'), review.checks.auditChainValid, review.checks.auditChainValid ? t('La chaîne d’empreintes du journal d’audit est valide.') : t('La chaîne d’audit est rompue ou illisible; ne clôturez pas avant vérification.')],
    [t('Pièces liées'), attachmentsReady, `${attachmentsReady ? verified > 1 ? t('{count} pièces contrôlées', { count: verified }) : t('{count} pièce contrôlée', { count: verified }) : attachmentProgress(verified, review.checks.attachmentsTotal)}.`],
    [t('Continuité comptable'), review.checks.continuity.totalAnomalies === 0, continuityReviewDetail(review.checks.continuity)],
  ];
  return <div className="closing-review-details">
    <div className="closing-review-check-grid">{items.map(([label, ready, detail]) => <article className={ready ? 'is-ready' : 'is-blocked'} key={label}>{ready ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<div><strong>{label}</strong><p>{detail}</p></div></article>)}</div>
    {review.checks.attachmentIssues.length ? <div className="closing-attachment-issues"><strong>{t('Pièces à corriger avant la clôture')}</strong><ul>{review.checks.attachmentIssues.map((issue) => <li key={`${issue.attachmentId}:${issue.issue}`}><span>{issue.originalName || issue.attachmentId || t('Pièce sans nom')}</span><small>{attachmentIssueLabel(issue.issue)}</small></li>)}</ul></div> : null}
  </div>;
}

function continuityReviewDetail(
  continuity: FiduciaryClosingReview['checks']['continuity'],
): string {
  if (continuity.totalAnomalies === 0) {
    return t('Aucune source comptable manquante ou incohérente n’a été détectée.');
  }
  const reversed = continuity.reversedSources + continuity.cancelledActivePostings;
  const payroll = continuity.undatedPayslipPayments + continuity.payslipPaymentLinksMissing;
  const details = [
    continuity.totalMissing > 1 ? t('{count} sources sans écriture', { count: continuity.totalMissing }) : continuity.totalMissing > 0 ? t('{count} source sans écriture', { count: continuity.totalMissing }) : '',
    continuity.closedHistoryRequiresOpening > 1 ? t('{count} reprises de soldes d’ouverture à valider', { count: continuity.closedHistoryRequiresOpening }) : continuity.closedHistoryRequiresOpening > 0 ? t('{count} reprise de soldes d’ouverture à valider', { count: continuity.closedHistoryRequiresOpening }) : '',
    continuity.semanticPostingMismatches > 1 ? t('{count} écritures différentes de sa source', { count: continuity.semanticPostingMismatches }) : continuity.semanticPostingMismatches > 0 ? t('{count} écriture différente de sa source', { count: continuity.semanticPostingMismatches }) : '',
    reversed > 1 ? t('{count} sources extournées ou annulées', { count: reversed }) : reversed > 0 ? t('{count} source extournée ou annulée', { count: reversed }) : '',
    continuity.cancelledInvoicePayments > 1 ? t('{count} paiements sur facture annulée', { count: continuity.cancelledInvoicePayments }) : continuity.cancelledInvoicePayments > 0 ? t('{count} paiement sur facture annulée', { count: continuity.cancelledInvoicePayments }) : '',
    payroll > 1 ? t('{count} contrôles de paiement salarial', { count: payroll }) : payroll > 0 ? t('{count} contrôle de paiement salarial', { count: payroll }) : '',
  ].filter(Boolean);
  const summary = details.join(' · ') || t('consultez Plan & liaisons');
  return continuity.totalAnomalies > 1
    ? t('{count} anomalies : {details}.', { count: continuity.totalAnomalies, details: summary })
    : t('{count} anomalie : {details}.', { count: continuity.totalAnomalies, details: summary });
}

function attachmentIssueLabel(issue: string): string {
  const labels: Record<string, string> = {
    unsafe_stored_name: t('Nom de stockage non sûr'),
    missing_or_unreadable_file: t('Fichier absent ou illisible'),
    symbolic_link_refused: t('Lien symbolique refusé'),
    not_a_regular_file: t('Élément non reconnu comme fichier'),
    unreadable_file: t('Fichier illisible'),
    size_mismatch: t('Taille différente de celle enregistrée'),
    sha256_mismatch_or_missing: t('Empreinte SHA-256 différente ou absente'),
    unknown_integrity_issue: t('Intégrité non vérifiable'),
  };
  return labels[issue] || t('Contrôle d’intégrité : {issue}', { issue: issue || t('erreur non détaillée') });
}

function StatementComparison({
  title,
  icon,
  currentLabel,
  previousLabel,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  currentLabel: string;
  previousLabel: string;
  rows: Array<[string, number | undefined, number | undefined]>;
}) {
  useAppLanguage();
  return <article className="closing-statement-card">
    <header>{icon}<strong>{title}</strong></header>
    <div className="table-panel"><table><thead><tr><th>{t('Position')}</th><th>{currentLabel || t('Courant')}</th><th>{previousLabel || statementTerm('Précédent')}</th></tr></thead><tbody>{rows.map(([label, current, previous]) => <tr key={label}><td>{label}</td><td>{current === undefined ? '—' : formatMoney(current)}</td><td>{previous === undefined ? '—' : formatMoney(previous)}</td></tr>)}</tbody></table></div>
  </article>;
}
