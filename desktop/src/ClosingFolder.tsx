import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Download, FileCheck2, Fingerprint, LockKeyhole, PackageCheck, Scale } from 'lucide-react';
import { desktopApi } from './bridge';
import { isMobileRuntime } from './mobileRuntime';
import type { AccountingPeriod, FiduciaryClosingReview, FiduciaryPackageExport, PeriodFilter, TrialBalanceReport } from './types';
import { buildClosingChecks, closingReadiness, type ComparativeBalanceSheet, type ComparativeIncomeStatement } from './accountingClosure';
import { errorMessage, formatDate, formatMoney } from './utils';
import { Button, EmptyState, ErrorPanel, SectionHeading } from './ui';
import './ClosingFolder.css';

export function ClosingFolder({
  filter,
  period,
  trial,
  balance,
  income,
  loading = false,
  onAccountingChanged,
}: {
  filter: PeriodFilter;
  period?: AccountingPeriod;
  trial: TrialBalanceReport | null;
  balance: ComparativeBalanceSheet | null;
  income: ComparativeIncomeStatement | null;
  loading?: boolean;
  onAccountingChanged?: () => Promise<void>;
}) {
  const [review, setReview] = useState<FiduciaryClosingReview | null>(null);
  const [exported, setExported] = useState<FiduciaryPackageExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const operation = useRef({ id: 0, busy: false });
  const checks = buildClosingChecks({ filter, period, trial, balance, income });
  const readiness = loading ? 'warning' : review && !review.checks.readyForFinal ? 'blocked' : closingReadiness(checks);
  const scope = balance?.scope ?? income?.scope;

  useEffect(() => {
    operation.current = { id: operation.current.id + 1, busy: false };
    setBusy(false);
    setReview(null);
    setExported(null);
    setConfirming(false);
    setConfirmation('');
    setError('');
    setNotice('');
    setNeedsRefresh(false);
    return () => { operation.current = { id: operation.current.id + 1, busy: false }; };
  }, [filter.dateFrom, filter.dateTo, period?.id]);

  function startOperation() {
    if (loading || operation.current.busy) return null;
    const id = operation.current.id + 1;
    operation.current = { id, busy: true };
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
    if (needsRefresh) return;
    const request = startOperation();
    if (request === null) return;
    setReview(null);
    setConfirming(false);
    setConfirmation('');
    try {
      const next = await desktopApi.prepareFiduciaryPreClosing(filter);
      if (operation.current.id !== request) return;
      if (next.period.id !== period?.id || next.period.dateFrom !== filter.dateFrom || next.period.dateTo !== filter.dateTo) {
        throw new Error('Le contrôle reçu ne correspond pas à l’exercice sélectionné. Préparez-le à nouveau.');
      }
      setReview(next);
      setExported(null);
      setNotice(next.checks.readyForFinal
        ? next.period.status === 'closed'
          ? 'Le contrôle est prêt. Vous pouvez exporter le dossier définitif.'
          : 'Le contrôle est prêt. Exportez un dossier provisoire ou confirmez la clôture définitive.'
        : 'Le contrôle est enregistré. Corrigez les points signalés avant la clôture définitive.');
    } catch (reason) {
      if (operation.current.id !== request) return;
      setError(errorMessage(reason, 'La pré-clôture n’a pas pu être préparée.'));
    } finally {
      finishOperation(request);
    }
  }

  async function finalizePeriod() {
    if (!review || review.period.id !== period?.id || needsRefresh) return;
    const targetPeriod = review.period;
    if (confirmation.trim() !== targetPeriod.name) {
      setError(`Saisissez exactement « ${targetPeriod.name} » pour confirmer le verrouillage définitif.`);
      return;
    }
    const request = startOperation();
    if (request === null) return;
    try {
      const result = await desktopApi.finalizeAccountingPeriodWithReview(targetPeriod.id, review.reviewId);
      if (operation.current.id !== request) return;
      setReview((current) => current ? { ...current, period: result.period, packageStatusIfExported: 'FINAL' } : current);
      setConfirming(false);
      setConfirmation('');
      setNotice('L’exercice est clôturé. Vous pouvez maintenant exporter le dossier définitif.');
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
      const detail = errorMessage(reason, 'Erreur locale non détaillée.');
      setNeedsRefresh(true);
      setError(`La période est bien verrouillée, mais les états affichés n’ont pas pu être actualisés. Actualisez les états avant de continuer. ${detail}`);
    } finally {
      finishOperation(request);
    }
  }

  async function exportPackage() {
    if (!review || review.period.id !== period?.id || needsRefresh) return;
    const request = startOperation();
    if (request === null) return;
    try {
      const result = await desktopApi.exportFiduciaryClosingZip(review.reviewId);
      if (operation.current.id !== request) return;
      setExported(result);
      setReview(null);
      setNotice(`Dossier ${result.packageStatus === 'FINAL' ? 'définitif' : 'provisoire'} enregistré : ${result.fileName}`);
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
      setNotice('Les états de l’exercice clôturé ont été actualisés. Vous pouvez exporter le dossier définitif.');
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
      setNotice('Le dossier existant a été proposé au partage.');
    } catch (reason) {
      if (operation.current.id !== request) return;
      setError(errorMessage(reason, 'Le partage n’a pas abouti. Le dossier exporté est conservé sur cet appareil.'));
    } finally {
      finishOperation(request);
    }
  }

  if (!filter.dateFrom || !filter.dateTo) {
    return <section className="panel closing-folder"><EmptyState icon={<FileCheck2 />} title="Choisissez un exercice" text="Le dossier de clôture exige une date de début et une date de fin explicites. Sélectionnez un exercice enregistré ou complétez les deux dates dans la barre supérieure." /></section>;
  }

  return <section className="panel closing-folder" aria-busy={busy || loading}>
    <SectionHeading
      eyebrow={period?.status === 'closed' ? 'Dossier verrouillé' : 'Dossier de travail'}
      title="Dossier de clôture"
      description="Vérifiez votre exercice, exportez un dossier provisoire, puis clôturez lorsque tout est prêt."
    />

    <div className={`closing-readiness is-${readiness}`}>
      {readiness === 'ready' ? <CheckCircle2 size={22} /> : readiness === 'blocked' ? <AlertTriangle size={22} /> : <CircleDashed size={22} />}
      <div>
        <strong>{loading ? 'Actualisation des états' : readiness === 'ready' ? 'Contrôles prêts' : readiness === 'blocked' ? 'Points à vérifier' : 'Dossier encore provisoire'}</strong>
        <p>{loading ? 'Les montants de l’exercice sélectionné sont en cours de chargement.' : readiness === 'ready' ? 'Les contrôles automatiques sont satisfaits.' : 'Préparez le contrôle pour vérifier les écritures et les pièces avant la clôture.'}</p>
      </div>
    </div>

    <section className="closing-workflow" aria-labelledby="closing-workflow-title">
      <header>
        <div><span>Clôture de l’exercice</span><h3 id="closing-workflow-title">Préparer le dossier</h3><p>Vérifiez les écritures et les pièces. Toute modification des données impose un nouveau contrôle avant la clôture.</p></div>
        <Button disabled={busy || loading || needsRefresh || !period || !filter.dateFrom || !filter.dateTo} onClick={() => void prepareReview()}><Fingerprint size={16} /> {review ? 'Repréparer le contrôle' : 'Préparer le contrôle'}</Button>
      </header>
      {!period ? <div className="closing-inline-warning"><AlertTriangle size={18} /><p>Enregistrez puis sélectionnez un exercice exact pour créer une pré-clôture traçable.</p></div> : null}
      {error ? <ErrorPanel message={error} reveal /> : null}
      {needsRefresh ? <Button variant="secondary" disabled={busy || loading} onClick={() => void refreshClosedPeriod()}>Actualiser les états</Button> : null}
      {notice ? <div className="notice notice--success" role="status" aria-live="polite"><CheckCircle2 size={17} />{notice}</div> : null}
      {review ? <div className="closing-review-card">
        <div className="closing-review-head"><div><span>Contrôle {review.checks.readyForFinal ? 'prêt' : 'à corriger'}</span><strong>{review.period.name}</strong><small>Empreinte {review.sourceSha256.slice(0, 16)}… · {review.summary.journalEntries} écriture{review.summary.journalEntries > 1 ? 's' : ''} · {review.checks.attachmentsVerified}/{review.checks.attachmentsTotal} pièce{review.checks.attachmentsTotal > 1 ? 's' : ''} vérifiée{review.checks.attachmentsVerified > 1 ? 's' : ''}</small></div><span className={`closing-review-badge ${review.checks.readyForFinal ? 'is-ready' : 'is-blocked'}`}>{review.checks.readyForFinal ? 'Prêt pour décision' : 'Bloqué'}</span></div>
        <ClosingReviewChecks review={review} />
        <div className="closing-review-actions">
          <Button variant="secondary" disabled={busy || loading || needsRefresh} onClick={() => void exportPackage()}><Download size={16} /> Exporter {review.period.status === 'closed' || review.packageStatusIfExported === 'FINAL' ? 'le dossier définitif' : 'un dossier provisoire'}</Button>
          {review.period.status === 'open' && review.checks.readyForFinal ? <Button disabled={busy || loading} onClick={() => setConfirming(true)}><LockKeyhole size={16} /> Clôturer définitivement</Button> : null}
        </div>
        {confirming ? <div className="closing-confirmation">
          <div><strong>Dernière confirmation</strong><p id="closing-confirmation-help">Cette action bloque toute nouvelle écriture du {formatDate(review.period.dateFrom)} au {formatDate(review.period.dateTo)}. Saisissez le nom exact de l’exercice.</p></div>
          <label><span>{review.period.name}</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="closing-confirmation-help" autoComplete="off" spellCheck={false} autoFocus /></label>
          <div className="form-actions"><Button variant="secondary" disabled={busy} onClick={() => { setConfirming(false); setConfirmation(''); setError(''); }}>Annuler</Button><Button disabled={busy || confirmation.trim() !== review.period.name} onClick={() => void finalizePeriod()}><LockKeyhole size={15} /> Verrouiller l’exercice</Button></div>
        </div> : null}
      </div> : null}
      {exported ? <div className="closing-export-card"><PackageCheck size={20} /><div><strong>Dossier {exported.packageStatus === 'FINAL' ? 'définitif' : 'provisoire'} exporté</strong><p>{exported.fileName} · {exported.fileCount} fichiers</p><small>{exported.path}</small><details><summary>Vérification du dossier</summary><small>Empreinte du manifeste : {exported.manifestSha256}</small></details>{isMobileRuntime() || exported.deliveryWarning ? <Button variant="secondary" disabled={busy || loading} onClick={() => void sharePackage()}>Partager le dossier</Button> : null}</div></div> : null}
    </section>

    <details className="closing-details">
    <summary>Bilan, résultat et contrôles détaillés</summary>
    <div className="closing-period-grid">
      <article><span>Exercice sous revue</span><strong>{formatDate(filter.dateFrom)} → {formatDate(filter.dateTo)}</strong><small>{period?.name ?? 'Période libre explicitement datée'}</small></article>
      <article><span>Comparatif</span><strong>{scope ? `${formatDate(scope.previousDateFrom)} → ${formatDate(scope.previousDateTo)}` : '—'}</strong><small>{scope?.comparisonLabel ?? 'Calcul en attente'}</small></article>
      <article><span>Monnaie de présentation</span><strong>{balance?.currency.baseCurrency ?? income?.currency.baseCurrency ?? '—'}</strong><small>Les états conservent leur monnaie comptable</small></article>
    </div>

    <div className="closing-comparison-grid">
      <StatementComparison
        title="Bilan"
        icon={<Scale size={18} />}
        currentLabel={formatDate(filter.dateTo)}
        previousLabel={formatDate(scope?.previousDateTo)}
        rows={[
          ['Actifs', balance?.assetsCents, balance?.previousAssetsCents],
          ['Dettes', balance?.liabilitiesCents, balance?.previousLiabilitiesCents],
          ['Fonds propres', balance?.equityCents, balance?.previousEquityCents],
          ['Résultats antérieurs non affectés', balance?.unallocatedPriorResultsCents, balance?.previousUnallocatedPriorResultsCents],
          ['Résultat de l’exercice', balance?.currentResultCents, balance?.previousCurrentResultCents],
        ]}
      />
      <StatementComparison
        title="Compte de résultat"
        icon={<FileCheck2 size={18} />}
        currentLabel={`${formatDate(filter.dateFrom)} – ${formatDate(filter.dateTo)}`}
        previousLabel={scope ? `${formatDate(scope.previousDateFrom)} – ${formatDate(scope.previousDateTo)}` : '—'}
        rows={[
          ['Produits', income?.revenueCents, income?.previousRevenueCents],
          ['Charges', income?.expenseCents, income?.previousExpenseCents],
          ['Bénéfice / perte', income?.profitCents, income?.previousProfitCents],
        ]}
      />
    </div>

    <div className="closing-checks">
      {checks.map((check) => <article key={check.id} className={`is-${check.state}`}>
        {check.state === 'ready' ? <CheckCircle2 size={18} /> : check.state === 'blocked' ? <AlertTriangle size={18} /> : <CircleDashed size={18} />}
        <div><strong>{check.label}</strong><p>{check.detail}</p></div>
      </article>)}
    </div>
    </details>

    <div className="closing-limitation">
      <LockKeyhole size={18} />
      <p><strong>Pièces complémentaires.</strong> L’annexe légale, les décisions d’approbation et, selon votre situation, la déclaration fiscale et le rapport de révision restent à établir séparément.</p>
    </div>
  </section>;
}

function ClosingReviewChecks({ review }: { review: FiduciaryClosingReview }) {
  const attachmentsReady = (
    review.checks.attachmentsTotal === review.checks.attachmentsVerified &&
    review.checks.attachmentIssues.length === 0
  );
  const items: Array<[string, boolean, string]> = [
    ['Journal', review.checks.journalBalanced, review.checks.journalBalanced ? 'Toutes les écritures contrôlées sont équilibrées.' : 'Au moins une écriture ou la balance des comptes présente un écart.'],
    ['Bilan', review.checks.balanceSheetBalanced, review.checks.balanceSheetBalanced ? 'L’équation du bilan est satisfaite.' : 'Le bilan ne respecte pas encore son équation d’équilibre.'],
    ['Journal d’audit', review.checks.auditChainValid, review.checks.auditChainValid ? 'La chaîne d’empreintes du journal d’audit est valide.' : 'La chaîne d’audit est rompue ou illisible; ne clôturez pas avant vérification.'],
    ['Pièces liées', attachmentsReady, attachmentsReady ? `${review.checks.attachmentsVerified} pièce${review.checks.attachmentsVerified > 1 ? 's' : ''} contrôlée${review.checks.attachmentsVerified > 1 ? 's' : ''}.` : `${review.checks.attachmentsVerified}/${review.checks.attachmentsTotal} pièce${review.checks.attachmentsTotal > 1 ? 's' : ''} vérifiée${review.checks.attachmentsVerified > 1 ? 's' : ''}.`],
    ['Continuité comptable', review.checks.continuity.totalAnomalies === 0, continuityReviewDetail(review.checks.continuity)],
  ];
  return <div className="closing-review-details">
    <div className="closing-review-check-grid">{items.map(([label, ready, detail]) => <article className={ready ? 'is-ready' : 'is-blocked'} key={label}>{ready ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<div><strong>{label}</strong><p>{detail}</p></div></article>)}</div>
    {review.checks.attachmentIssues.length ? <div className="closing-attachment-issues"><strong>Pièces à corriger avant la clôture</strong><ul>{review.checks.attachmentIssues.map((issue) => <li key={`${issue.attachmentId}:${issue.issue}`}><span>{issue.originalName || issue.attachmentId || 'Pièce sans nom'}</span><small>{attachmentIssueLabel(issue.issue)}</small></li>)}</ul></div> : null}
  </div>;
}

function continuityReviewDetail(
  continuity: FiduciaryClosingReview['checks']['continuity'],
): string {
  if (continuity.totalAnomalies === 0) {
    return 'Aucune source comptable manquante ou incohérente n’a été détectée.';
  }
  const details = [
    continuity.totalMissing > 0 ? `${continuity.totalMissing} source${continuity.totalMissing > 1 ? 's' : ''} sans écriture` : '',
    continuity.closedHistoryRequiresOpening > 0 ? `${continuity.closedHistoryRequiresOpening} reprise${continuity.closedHistoryRequiresOpening > 1 ? 's' : ''} de soldes d’ouverture à valider` : '',
    continuity.semanticPostingMismatches > 0 ? `${continuity.semanticPostingMismatches} écriture${continuity.semanticPostingMismatches > 1 ? 's' : ''} différente${continuity.semanticPostingMismatches > 1 ? 's' : ''} de sa source` : '',
    continuity.reversedSources + continuity.cancelledActivePostings > 0 ? `${continuity.reversedSources + continuity.cancelledActivePostings} source${continuity.reversedSources + continuity.cancelledActivePostings > 1 ? 's' : ''} extournée${continuity.reversedSources + continuity.cancelledActivePostings > 1 ? 's' : ''} ou annulée${continuity.reversedSources + continuity.cancelledActivePostings > 1 ? 's' : ''}` : '',
    continuity.cancelledInvoicePayments > 0 ? `${continuity.cancelledInvoicePayments} paiement${continuity.cancelledInvoicePayments > 1 ? 's' : ''} sur facture annulée` : '',
    continuity.undatedPayslipPayments + continuity.payslipPaymentLinksMissing > 0 ? `${continuity.undatedPayslipPayments + continuity.payslipPaymentLinksMissing} contrôle${continuity.undatedPayslipPayments + continuity.payslipPaymentLinksMissing > 1 ? 's' : ''} de paiement salarial` : '',
  ].filter(Boolean);
  return `${continuity.totalAnomalies} anomalie${continuity.totalAnomalies > 1 ? 's' : ''} : ${details.join(' · ') || 'consultez Plan & liaisons'}.`;
}

function attachmentIssueLabel(issue: string): string {
  const labels: Record<string, string> = {
    unsafe_stored_name: 'Nom de stockage non sûr',
    missing_or_unreadable_file: 'Fichier absent ou illisible',
    symbolic_link_refused: 'Lien symbolique refusé',
    not_a_regular_file: 'Élément non reconnu comme fichier',
    unreadable_file: 'Fichier illisible',
    size_mismatch: 'Taille différente de celle enregistrée',
    sha256_mismatch_or_missing: 'Empreinte SHA-256 différente ou absente',
    unknown_integrity_issue: 'Intégrité non vérifiable',
  };
  return labels[issue] || `Contrôle d’intégrité : ${issue || 'erreur non détaillée'}`;
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
  return <article className="closing-statement-card">
    <header>{icon}<strong>{title}</strong></header>
    <div className="table-panel"><table><thead><tr><th>Position</th><th>{currentLabel || 'Courant'}</th><th>{previousLabel || 'Précédent'}</th></tr></thead><tbody>{rows.map(([label, current, previous]) => <tr key={label}><td>{label}</td><td>{current === undefined ? '—' : formatMoney(current)}</td><td>{previous === undefined ? '—' : formatMoney(previous)}</td></tr>)}</tbody></table></div>
  </article>;
}
