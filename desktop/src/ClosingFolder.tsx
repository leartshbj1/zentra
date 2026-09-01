import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Download, FileCheck2, Fingerprint, LockKeyhole, PackageCheck, Scale } from 'lucide-react';
import { desktopApi } from './bridge';
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
  onAccountingChanged,
}: {
  filter: PeriodFilter;
  period?: AccountingPeriod;
  trial: TrialBalanceReport | null;
  balance: ComparativeBalanceSheet | null;
  income: ComparativeIncomeStatement | null;
  onAccountingChanged?: () => Promise<void>;
}) {
  const [review, setReview] = useState<FiduciaryClosingReview | null>(null);
  const [exported, setExported] = useState<FiduciaryPackageExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const checks = buildClosingChecks({ filter, period, trial, balance, income });
  const readiness = closingReadiness(checks);
  const scope = balance?.scope ?? income?.scope;

  useEffect(() => {
    setReview(null);
    setExported(null);
    setConfirming(false);
    setConfirmation('');
    setError('');
    setNotice('');
  }, [filter.dateFrom, filter.dateTo, period?.id]);

  async function prepareReview() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await desktopApi.prepareFiduciaryPreClosing(filter);
      setReview(next);
      setExported(null);
      setNotice(next.checks.readyForFinal
        ? 'Le contrôle figé est prêt. Vous pouvez exporter un dossier DRAFT ou confirmer la clôture définitive.'
        : 'Le contrôle figé a été créé, mais ses points bloquants doivent être corrigés avant la clôture définitive.');
    } catch (reason) {
      setError(errorMessage(reason, 'La pré-clôture n’a pas pu être préparée.'));
    } finally {
      setBusy(false);
    }
  }

  async function finalizePeriod() {
    if (!review) return;
    const targetPeriod = review.period;
    if (confirmation.trim() !== targetPeriod.name) {
      setError(`Saisissez exactement « ${targetPeriod.name} » pour confirmer le verrouillage définitif.`);
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await desktopApi.finalizeAccountingPeriodWithReview(targetPeriod.id, review.reviewId);
      setReview((current) => current ? { ...current, period: result.period, packageStatusIfExported: 'FINAL' } : current);
      setConfirming(false);
      setConfirmation('');
      setNotice('La période est verrouillée. La même empreinte peut maintenant produire le dossier FINAL.');
    } catch (reason) {
      setError(errorMessage(reason, 'La clôture définitive a été refusée. Préparez un nouveau contrôle si les données ont changé.'));
      setBusy(false);
      return;
    }
    try {
      await onAccountingChanged?.();
    } catch (reason) {
      const detail = errorMessage(reason, 'Erreur locale non détaillée.');
      setError(`La période est bien verrouillée, mais les états affichés n’ont pas pu être actualisés. Utilisez « Actualiser » avant de continuer. ${detail}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportPackage() {
    if (!review) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await desktopApi.exportFiduciaryClosingZip(review.reviewId);
      setExported(result);
      setReview(null);
      setNotice(`Dossier ${result.packageStatus} créé localement : ${result.path}`);
    } catch (reason) {
      setError(errorMessage(reason, 'Le dossier fiduciaire n’a pas pu être exporté.'));
    } finally {
      setBusy(false);
    }
  }

  if (!filter.dateFrom || !filter.dateTo) {
    return <section className="panel closing-folder"><EmptyState icon={<FileCheck2 />} title="Choisissez un exercice" text="Le dossier de clôture exige une date de début et une date de fin explicites. Sélectionnez un exercice enregistré ou complétez les deux dates dans la barre supérieure." /></section>;
  }

  return <section className="panel closing-folder" aria-busy={busy}>
    <SectionHeading
      eyebrow={period?.status === 'closed' ? 'Dossier verrouillé' : 'Dossier de travail'}
      title="Dossier de clôture"
      description="Vue de contrôle lisible des états, des comparatifs et des conditions techniques de clôture."
    />

    <div className={`closing-readiness is-${readiness}`}>
      {readiness === 'ready' ? <CheckCircle2 size={22} /> : readiness === 'blocked' ? <AlertTriangle size={22} /> : <CircleDashed size={22} />}
      <div>
        <strong>{readiness === 'ready' ? 'Contrôles techniques prêts' : readiness === 'blocked' ? 'Clôture technique bloquée' : 'Dossier encore provisoire'}</strong>
        <p>{readiness === 'ready' ? 'Les contrôles automatisables ci-dessous sont satisfaits.' : 'Consultez les contrôles ci-dessous avant de verrouiller la période.'}</p>
      </div>
    </div>

    <div className="closing-period-grid">
      <article><span>Exercice sous revue</span><strong>{formatDate(filter.dateFrom)} → {formatDate(filter.dateTo)}</strong><small>{period?.name ?? 'Période libre explicitement datée'}</small></article>
      <article><span>Comparatif</span><strong>{scope ? `${formatDate(scope.previousDateFrom)} → ${formatDate(scope.previousDateTo)}` : '—'}</strong><small>{scope?.comparisonLabel ?? 'Calcul en attente'}</small></article>
      <article><span>Monnaie de présentation</span><strong>{balance?.currency.baseCurrency ?? income?.currency.baseCurrency ?? '—'}</strong><small>Conversion implicite interdite</small></article>
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

    <section className="closing-workflow" aria-labelledby="closing-workflow-title">
      <header>
        <div><span>Deux étapes vérifiables</span><h3 id="closing-workflow-title">Préparer, contrôler, puis verrouiller</h3><p>Chaque contrôle reçoit une empreinte SHA-256. Si une écriture, une pièce ou un réglage change, Zentra refuse d’utiliser l’ancien contrôle.</p></div>
        <Button disabled={busy || !period || !filter.dateFrom || !filter.dateTo} onClick={() => void prepareReview()}><Fingerprint size={16} /> {review ? 'Repréparer le contrôle' : 'Préparer le contrôle'}</Button>
      </header>
      {!period ? <div className="closing-inline-warning"><AlertTriangle size={18} /><p>Enregistrez puis sélectionnez un exercice exact pour créer une pré-clôture traçable.</p></div> : null}
      {error ? <ErrorPanel message={error} /> : null}
      {notice ? <div className="notice notice--success" role="status" aria-live="polite"><CheckCircle2 size={17} />{notice}</div> : null}
      {review ? <div className="closing-review-card">
        <div className="closing-review-head"><div><span>Contrôle {review.checks.readyForFinal ? 'prêt' : 'à corriger'}</span><strong>{review.period.name}</strong><small>Empreinte {review.sourceSha256.slice(0, 16)}… · {review.summary.journalEntries} écriture{review.summary.journalEntries > 1 ? 's' : ''} · {review.checks.attachmentsVerified}/{review.checks.attachmentsTotal} pièce{review.checks.attachmentsTotal > 1 ? 's' : ''} vérifiée{review.checks.attachmentsVerified > 1 ? 's' : ''}</small></div><span className={`closing-review-badge ${review.checks.readyForFinal ? 'is-ready' : 'is-blocked'}`}>{review.checks.readyForFinal ? 'Prêt pour décision' : 'Bloqué'}</span></div>
        <ClosingReviewChecks review={review} />
        <div className="closing-review-actions">
          <Button variant="secondary" disabled={busy} onClick={() => void exportPackage()}><Download size={16} /> Exporter {review.period.status === 'closed' || review.packageStatusIfExported === 'FINAL' ? 'le dossier FINAL' : 'un dossier DRAFT'}</Button>
          {review.period.status === 'open' && review.checks.readyForFinal ? <Button disabled={busy} onClick={() => setConfirming(true)}><LockKeyhole size={16} /> Clôturer définitivement</Button> : null}
        </div>
        {confirming ? <div className="closing-confirmation">
          <div><strong>Dernière confirmation</strong><p id="closing-confirmation-help">Cette action bloque toute nouvelle écriture du {formatDate(review.period.dateFrom)} au {formatDate(review.period.dateTo)}. Saisissez le nom exact de l’exercice.</p></div>
          <label><span>{review.period.name}</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="closing-confirmation-help" autoComplete="off" spellCheck={false} autoFocus /></label>
          <div className="form-actions"><Button variant="secondary" disabled={busy} onClick={() => { setConfirming(false); setConfirmation(''); setError(''); }}>Annuler</Button><Button disabled={busy || confirmation.trim() !== review.period.name} onClick={() => void finalizePeriod()}><LockKeyhole size={15} /> Verrouiller l’exercice</Button></div>
        </div> : null}
      </div> : null}
      {exported ? <div className="closing-export-card"><PackageCheck size={20} /><div><strong>Dossier {exported.packageStatus} exporté</strong><p>{exported.fileName} · {exported.fileCount} fichiers · manifeste {exported.manifestSha256.slice(0, 16)}…</p><small>{exported.path}</small></div></div> : null}
    </section>

    <div className="closing-limitation">
      <LockKeyhole size={18} />
      <p><strong>Périmètre honnête.</strong> Ce dossier assiste la clôture technique locale. Il ne génère pas l’annexe légale, les décisions d’approbation, une déclaration fiscale, un rapport de révision ou une signature; ces pièces doivent être établies et validées séparément par les responsables compétents.</p>
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
    <div className="table-panel"><table><thead><tr><th>Position</th><th>{currentLabel || 'Courant'}</th><th>{previousLabel || 'Précédent'}</th></tr></thead><tbody>{rows.map(([label, current, previous]) => <tr key={label}><td>{label}</td><td>{formatMoney(current)}</td><td>{formatMoney(previous)}</td></tr>)}</tbody></table></div>
  </article>;
}
