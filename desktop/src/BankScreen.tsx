import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Copy,
  FileCode2,
  FileUp,
  History,
  Landmark,
  Link2,
  LoaderCircle,
  RefreshCw,
  Receipt,
  Search,
  ShieldCheck,
  Unlink,
} from 'lucide-react';
import { desktopApi } from './bridge';
import {
  canConfirmBankReconciliation,
  canConfirmSupplierBankReconciliation,
  candidateForInvoice,
  candidateForSupplierInvoice,
  filterBankCandidates,
  filterBankMovements,
  filterBankSupplierCandidates,
  importCamtFromLocalDialog,
  initialInvoiceChoice,
  initialSupplierInvoiceChoice,
  type BankMovementFilter,
} from './bank';
import type { BankAccountLink, BankMovement, BankWorkspace, Workspace } from './types';
import { errorMessage, formatDate, formatDateTime } from './utils';
import { Button, EmptyState, ErrorPanel, SectionHeading } from './ui';

type Feedback = { tone: 'success' | 'warning' | 'error'; title: string; text: string; warnings?: string[] };

const filterLabels: Record<BankMovementFilter, string> = {
  unreconciled: 'À rapprocher',
  pending: 'En attente',
  reconciled: 'Rapprochés',
  all: 'Tous',
};

const suggestionLabels: Record<BankMovement['suggestion']['kind'], string> = {
  automatic_exact: 'Correspondance exacte',
  automatic_partial: 'Paiement partiel détecté',
  manual: 'Choix manuel',
  review: 'Contrôle nécessaire',
  none: 'Aucune proposition',
};

const supplierSuggestionLabels: Record<BankMovement['supplierSuggestion']['kind'], string> = {
  supplier_match: 'Facture fournisseur reconnue',
  supplier_manual: 'Choix fournisseur requis',
  review: 'Contrôle nécessaire',
  none: 'Aucune proposition',
};

function formatBankMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('fr-CH', { style: 'currency', currency: currency || 'CHF', minimumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || 'CHF'}`;
  }
}

function displayMovementAmount(movement: BankMovement): string {
  const magnitude = Math.abs(movement.amountCents);
  return `${movement.creditDebit === 'DBIT' ? '−' : '+'} ${formatBankMoney(magnitude, movement.currency)}`;
}

function referenceLabel(type: string): string {
  return ({ QRR: 'Référence QR', SCOR: 'Référence créancier', CONFLICT: 'Références contradictoires', NON: 'Communication libre' } as Record<string, string>)[type] ?? 'Référence bancaire';
}

function shortSha256(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 14)}…${value.slice(-8)}`;
}

function commonMovementBlockReason(movement: BankMovement, account: BankAccountLink | undefined, accountingReady: boolean): string {
  if (!accountingReady) return 'Activez la comptabilité et ses onze comptes de liaison avant de confirmer le rapprochement.';
  if (!account?.linked) return 'Associez d’abord ce compte à votre entreprise.';
  if (movement.status === 'PDNG') return 'Ce mouvement est encore en attente auprès de la banque.';
  if (movement.reversal) return 'Une extourne ne peut pas être rapprochée comme paiement.';
  if (movement.reconciliation || movement.supplierReconciliation) return 'Ce mouvement a déjà été rapproché.';
  return '';
}

function customerMovementBlockReason(movement: BankMovement, account: BankAccountLink | undefined, invoiceId: string, accountingReady: boolean): string {
  const commonReason = commonMovementBlockReason(movement, account, accountingReady);
  if (commonReason) return commonReason;
  if (movement.creditDebit !== 'CRDT') return 'Seule une entrée bancaire peut encaisser une facture client.';
  if (!invoiceId) return 'Choisissez explicitement la facture à rapprocher.';
  const candidate = candidateForInvoice(movement, invoiceId);
  if (!candidate?.confirmable) return candidate?.reason || 'Cette facture ne peut pas recevoir ce mouvement.';
  if (candidate.remainingCents < Math.abs(movement.amountCents)) return 'Le montant bancaire dépasse le solde restant de cette facture.';
  if (!movement.suggestion.confirmable) return movement.suggestion.reason || 'Le backend demande un contrôle supplémentaire.';
  return '';
}

function supplierMovementBlockReason(movement: BankMovement, account: BankAccountLink | undefined, supplierInvoiceId: string, accountingReady: boolean): string {
  const commonReason = commonMovementBlockReason(movement, account, accountingReady);
  if (commonReason) return commonReason;
  if (movement.creditDebit !== 'DBIT') return 'Seule une sortie bancaire peut régler une facture fournisseur.';
  if (!supplierInvoiceId) return 'Choisissez explicitement la facture fournisseur à rapprocher.';
  const candidate = candidateForSupplierInvoice(movement, supplierInvoiceId);
  if (!candidate?.confirmable) return candidate?.reason || 'Cette facture fournisseur ne peut pas recevoir ce débit.';
  if (candidate.remainingCents < Math.abs(movement.amountCents)) return 'Le débit dépasse le solde restant de cette facture fournisseur.';
  if (!movement.supplierSuggestion.confirmable) return movement.supplierSuggestion.reason || 'Le contrôle local demande une vérification supplémentaire.';
  if (!movement.supplierSuggestion.requiresConfirmation) return 'Cette proposition ne possède pas la preuve de confirmation humaine requise.';
  return '';
}

function BankCandidatePicker({
  movement,
  workspace,
  selectedInvoiceId,
  query,
  onQueryChange,
  onSelect,
}: {
  movement: BankMovement;
  workspace: Workspace;
  selectedInvoiceId: string;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (invoiceId: string) => void;
}) {
  const candidates = filterBankCandidates(movement, workspace.invoices, workspace.clients, query);
  const searchable = movement.suggestion.kind === 'manual' || movement.suggestion.kind === 'review' || movement.suggestion.candidates.length > 1;
  return <div className="bank-candidate-picker">
    <div className="bank-candidate-picker__heading"><span>Facture à rapprocher</span><small>{movement.suggestion.candidates.length} proposition{movement.suggestion.candidates.length > 1 ? 's' : ''}</small></div>
    {searchable ? <label className="bank-candidate-search"><Search size={14} /><span className="sr-only">Rechercher une facture par numéro, client ou montant</span><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="N°, client ou montant…" /></label> : null}
    <div className="bank-candidate-options" role="radiogroup" aria-label="Choisir explicitement la facture à rapprocher">
      {candidates.map(({ candidate, invoiceNumber, invoiceTitle, clientName, dueDate }) => <label className={`bank-candidate-option ${selectedInvoiceId === candidate.invoiceId ? 'is-selected' : ''} ${candidate.confirmable ? '' : 'is-blocked'}`} key={candidate.invoiceId}>
        <input className="sr-only" type="radio" name={`bank-candidate-${movement.id}`} value={candidate.invoiceId} checked={selectedInvoiceId === candidate.invoiceId} disabled={!candidate.confirmable} onChange={() => onSelect(candidate.invoiceId)} />
        <span className="bank-candidate-option__icon"><Receipt size={15} /></span>
        <span className="bank-candidate-option__identity"><strong>{invoiceNumber}</strong><span>{clientName}</span><small>{invoiceTitle || (dueDate ? `Échéance ${formatDate(dueDate)}` : 'Facture ouverte')}</small></span>
        <span className="bank-candidate-option__amount"><strong>{formatBankMoney(candidate.remainingCents, movement.currency)}</strong><small>solde ouvert</small></span>
        <span className="bank-candidate-option__reason">{candidate.confirmable ? candidate.reason || 'Montant compatible.' : `Bloqué · ${candidate.reason || 'Non confirmable'}`}</span>
      </label>)}
      {!candidates.length ? <div className="bank-candidate-empty" role="status">Aucune facture ne correspond à « {query.trim()} ».</div> : null}
    </div>
  </div>;
}

function BankSupplierCandidatePicker({
  movement,
  workspace,
  selectedSupplierInvoiceId,
  query,
  onQueryChange,
  onSelect,
}: {
  movement: BankMovement;
  workspace: Workspace;
  selectedSupplierInvoiceId: string;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (supplierInvoiceId: string) => void;
}) {
  const candidates = filterBankSupplierCandidates(movement, workspace.supplierInvoices, workspace.suppliers, query);
  const searchable = movement.supplierSuggestion.kind !== 'supplier_match' || movement.supplierSuggestion.candidates.length > 1;
  return <div className="bank-candidate-picker">
    <div className="bank-candidate-picker__heading"><span>Facture fournisseur à régler</span><small>{movement.supplierSuggestion.candidates.length} proposition{movement.supplierSuggestion.candidates.length > 1 ? 's' : ''}</small></div>
    {searchable ? <label className="bank-candidate-search"><Search size={14} /><span className="sr-only">Rechercher une facture par référence, fournisseur, IBAN ou montant</span><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Référence, fournisseur, IBAN ou montant…" /></label> : null}
    <div className="bank-candidate-options" role="radiogroup" aria-label="Choisir explicitement la facture fournisseur à rapprocher">
      {candidates.map(({ candidate, supplierName, supplierIban, invoiceReference, documentDate, dueDate }) => <label className={`bank-candidate-option ${selectedSupplierInvoiceId === candidate.supplierInvoiceId ? 'is-selected' : ''} ${candidate.confirmable ? '' : 'is-blocked'}`} key={candidate.supplierInvoiceId}>
        <input className="sr-only" type="radio" name={`bank-supplier-candidate-${movement.id}`} value={candidate.supplierInvoiceId} checked={selectedSupplierInvoiceId === candidate.supplierInvoiceId} disabled={!candidate.confirmable} onChange={() => onSelect(candidate.supplierInvoiceId)} />
        <span className="bank-candidate-option__icon"><Receipt size={15} /></span>
        <span className="bank-candidate-option__identity"><strong>{invoiceReference || 'Sans référence'}</strong><span>{supplierName}</span><small>{documentDate ? `Facture du ${formatDate(documentDate)}` : dueDate ? `Échéance ${formatDate(dueDate)}` : supplierIban || 'Facture fournisseur ouverte'}</small></span>
        <span className="bank-candidate-option__amount"><strong>{formatBankMoney(candidate.remainingCents, movement.currency)}</strong><small>solde ouvert</small></span>
        <span className="bank-candidate-option__reason">{candidate.confirmable ? `Confirmable · ${candidate.reason || 'Montant et devise compatibles.'}` : `Bloqué · ${candidate.reason || 'Non confirmable'}`}</span>
      </label>)}
      {!candidates.length ? <div className="bank-candidate-empty" role="status">Aucune facture fournisseur ne correspond à « {query.trim()} ».</div> : null}
    </div>
  </div>;
}

export function BankScreen({
  workspace,
  readOnly,
  onWorkspaceChange,
  onOpenAccounting,
}: {
  workspace: Workspace;
  readOnly: boolean;
  onWorkspaceChange: (workspace: Workspace) => void;
  onOpenAccounting: () => void;
}) {
  const [bank, setBank] = useState<BankWorkspace | null>(null);
  const [filter, setFilter] = useState<BankMovementFilter>('unreconciled');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [candidateQueries, setCandidateQueries] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const accounting = workspace.accountingSettings;
  const accountingReady = Boolean(accounting?.enabled && [
    accounting.arAccountId,
    accounting.revenueAccountId,
    accounting.vatPayableAccountId,
    accounting.bankAccountId,
    accounting.expenseAccountId,
    accounting.vatReceivableAccountId,
    accounting.wagesExpenseAccountId,
    accounting.wagesPayableAccountId,
    accounting.socialExpenseAccountId,
    accounting.socialPayableAccountId,
    accounting.supplierPayableAccountId,
  ].every(Boolean));

  const load = useCallback(async () => {
    setError('');
    try {
      const next = await desktopApi.getBankWorkspace();
      setBank(next);
      setChoices((current) => Object.fromEntries(next.movements.map((movement) => {
        const retained = current[movement.id];
        const candidates = movement.creditDebit === 'DBIT'
          ? movement.supplierSuggestion.candidates.map((candidate) => candidate.supplierInvoiceId)
          : movement.suggestion.candidates.map((candidate) => candidate.invoiceId);
        const stillAvailable = retained && candidates.includes(retained);
        const initialChoice = movement.creditDebit === 'DBIT' ? initialSupplierInvoiceChoice(movement) : initialInvoiceChoice(movement);
        return [movement.id, stillAvailable ? retained : initialChoice];
      })));
    } catch (reason) {
      setError(errorMessage(reason, 'L’espace bancaire local n’a pas pu être chargé.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const movements = useMemo(() => bank ? filterBankMovements(bank.movements, filter) : [], [bank, filter]);
  const counts = useMemo(() => bank ? {
    unreconciled: filterBankMovements(bank.movements, 'unreconciled').length,
    pending: filterBankMovements(bank.movements, 'pending').length,
    reconciled: filterBankMovements(bank.movements, 'reconciled').length,
    all: bank.movements.length,
  } : { unreconciled: 0, pending: 0, reconciled: 0, all: 0 }, [bank]);

  function accountFor(movement: BankMovement): BankAccountLink | undefined {
    return bank?.accounts.find((account) => account.accountId === movement.accountId && account.currency === movement.accountCurrency);
  }

  async function importStatement() {
    if (readOnly) {
      setFeedback({ tone: 'error', title: 'Licence en lecture seule', text: 'Activez la licence avant d’importer un nouveau relevé.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const result = await importCamtFromLocalDialog(desktopApi.chooseCamtFile, desktopApi.importCamtFile);
      if (!result) return;
      await load();
      setFeedback({
        tone: result.duplicate || result.warnings.length ? 'warning' : 'success',
        title: result.duplicate ? 'Relevé déjà connu' : 'Relevé importé localement',
        text: result.duplicate
          ? `Aucun doublon n’a été créé. ${result.skippedDuplicateCount} mouvement${result.skippedDuplicateCount > 1 ? 's ont' : ' a'} été ignoré${result.skippedDuplicateCount > 1 ? 's' : ''}.`
          : `${result.importedCount} mouvement${result.importedCount > 1 ? 's' : ''} ajouté${result.importedCount > 1 ? 's' : ''}. ${result.ignoredCount ? `${result.ignoredCount} entrée${result.ignoredCount > 1 ? 's' : ''} non exploitable${result.ignoredCount > 1 ? 's' : ''}.` : 'Toutes les entrées compatibles ont été lues.'}`,
        warnings: result.warnings,
      });
    } catch (reason) {
      setFeedback({ tone: 'error', title: 'Import impossible', text: errorMessage(reason, 'Le fichier CAMT n’a pas pu être lu localement.') });
    } finally {
      setBusy(false);
    }
  }

  async function associate(account: BankAccountLink) {
    if (readOnly || busy) return;
    if (!window.confirm(`Associer le compte « ${account.accountId} » (${account.currency}) à cette entreprise ?\n\nCette confirmation crée uniquement un lien dans Elyko sur ce PC. Aucun accès bancaire n’est ouvert et aucun mouvement n’est rapproché automatiquement.`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await desktopApi.associateBankAccount(account.accountId, account.currency);
      await load();
      setFeedback({ tone: 'success', title: 'Compte associé', text: 'Les propositions sûres de ce compte sont maintenant disponibles. Chaque rapprochement reste soumis à votre confirmation.' });
    } catch (reason) {
      setFeedback({ tone: 'error', title: 'Association impossible', text: errorMessage(reason, 'Ce compte n’a pas pu être associé à l’entreprise.') });
    } finally {
      setBusy(false);
    }
  }

  async function dissociate(account: BankAccountLink) {
    if (readOnly || busy || account.linkSource !== 'explicit') return;
    if (!window.confirm(`Dissocier le compte « ${account.accountId} » (${account.currency}) ?\n\nLes mouvements importés et les rapprochements déjà confirmés resteront dans l’historique. Les nouvelles propositions seront bloquées jusqu’à une nouvelle association.`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await desktopApi.dissociateBankAccount(account.accountId, account.currency);
      await load();
      setFeedback({ tone: 'success', title: 'Compte dissocié', text: 'Les mouvements restent visibles, mais aucun nouveau rapprochement ne peut être confirmé pour ce compte.' });
    } catch (reason) {
      setFeedback({ tone: 'error', title: 'Dissociation impossible', text: errorMessage(reason, 'Ce compte n’a pas pu être dissocié.') });
    } finally {
      setBusy(false);
    }
  }

  async function confirmMovement(movement: BankMovement) {
    const invoiceId = choices[movement.id] ?? '';
    const account = accountFor(movement);
    const blockReason = customerMovementBlockReason(movement, account, invoiceId, accountingReady);
    if (blockReason || !canConfirmBankReconciliation(movement, invoiceId)) {
      setFeedback({ tone: 'error', title: 'Rapprochement bloqué', text: blockReason || 'Cette proposition ne peut pas être confirmée.' });
      return;
    }
    const invoice = workspace.invoices.find((candidate) => candidate.id === invoiceId);
    const candidate = candidateForInvoice(movement, invoiceId);
    const invoiceLabel = invoice?.number || candidate?.invoiceNumber || 'facture sélectionnée';
    if (!window.confirm(`Confirmer le rapprochement de ${formatBankMoney(Math.abs(movement.amountCents), movement.currency)} avec la facture ${invoiceLabel} ?\n\nElyko va enregistrer le paiement et son écriture bancaire dans la même transaction locale. Si un contrôle échoue, aucune donnée ne sera modifiée.`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await desktopApi.confirmBankReconciliation(movement.id, invoiceId);
      const [nextWorkspace, nextBank] = await Promise.all([desktopApi.loadWorkspace(), desktopApi.getBankWorkspace()]);
      onWorkspaceChange(nextWorkspace);
      setBank(nextBank);
      setFeedback({ tone: 'success', title: 'Rapprochement confirmé', text: `${formatBankMoney(Math.abs(movement.amountCents), movement.currency)} a été enregistré sur ${invoiceLabel}.` });
    } catch (reason) {
      setFeedback({ tone: 'error', title: 'Rapprochement refusé', text: errorMessage(reason, 'Aucune écriture n’a été créée. Contrôlez la facture et le mouvement.') });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function confirmSupplierMovement(movement: BankMovement) {
    const supplierInvoiceId = choices[movement.id] ?? '';
    const account = accountFor(movement);
    const blockReason = supplierMovementBlockReason(movement, account, supplierInvoiceId, accountingReady);
    if (blockReason || !canConfirmSupplierBankReconciliation(movement, supplierInvoiceId)) {
      setFeedback({ tone: 'error', title: 'Rapprochement fournisseur bloqué', text: blockReason || 'Cette proposition ne peut pas être confirmée.' });
      return;
    }
    const invoice = workspace.supplierInvoices.find((candidate) => candidate.id === supplierInvoiceId);
    const candidate = candidateForSupplierInvoice(movement, supplierInvoiceId);
    const invoiceLabel = invoice?.reference || candidate?.reference || 'facture fournisseur sélectionnée';
    const supplierLabel = invoice?.supplierName || candidate?.supplierName || 'le fournisseur';
    if (!window.confirm(`Confirmer la sortie de ${formatBankMoney(Math.abs(movement.amountCents), movement.currency)} pour ${supplierLabel}, facture ${invoiceLabel} ?\n\nElyko va enregistrer le paiement fournisseur et son écriture bancaire dans la même transaction locale. Si un contrôle échoue, aucune donnée ne sera modifiée.`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await desktopApi.confirmSupplierBankReconciliation(movement.id, supplierInvoiceId);
      const [nextWorkspace, nextBank] = await Promise.all([desktopApi.loadWorkspace(), desktopApi.getBankWorkspace()]);
      onWorkspaceChange(nextWorkspace);
      setBank(nextBank);
      setFeedback({ tone: 'success', title: 'Règlement fournisseur confirmé', text: `${formatBankMoney(Math.abs(movement.amountCents), movement.currency)} a été enregistré sur ${invoiceLabel}.` });
    } catch (reason) {
      setFeedback({ tone: 'error', title: 'Rapprochement fournisseur refusé', text: errorMessage(reason, 'Aucune écriture n’a été créée. Contrôlez la facture fournisseur et le débit.') });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copyImportFingerprint(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ tone: 'success', title: 'Empreinte copiée', text: 'L’empreinte SHA-256 complète est dans le presse-papiers.' });
    } catch (reason) {
      setFeedback({ tone: 'error', title: 'Copie impossible', text: errorMessage(reason, `Empreinte SHA-256 : ${value}`) });
    }
  }

  if (loading) return <div className="bank-loading" role="status"><LoaderCircle className="spin" size={19} /> Chargement de l’espace bancaire local…</div>;
  if (error && !bank) return <ErrorPanel title="Banque indisponible" message={error} onRetry={() => { setLoading(true); void load(); }} />;
  if (!bank) return null;

  return <div className="stack-layout bank-screen">
    <section className="bank-hero">
      <div className="bank-hero__icon"><Landmark size={25} /></div>
      <div><p className="eyebrow">ISO 20022 · traitement local</p><h2>Rapprochez vos encaissements et règlements en gardant le contrôle.</h2><p>Importez un XML CAMT fourni par votre banque. Elyko distingue les entrées clients des sorties fournisseurs, sans connexion au compte ni paiement créé avant votre confirmation.</p></div>
      <Button disabled={busy || readOnly} onClick={() => void importStatement()} title={readOnly ? 'Licence en lecture seule' : 'Choisir un fichier XML sur ce PC'}>{busy ? <LoaderCircle className="spin" size={16} /> : <FileUp size={16} />} Importer un relevé XML</Button>
    </section>

    {feedback ? <div className={`bank-feedback bank-feedback--${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
      {feedback.tone === 'success' ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}
      <div><strong>{feedback.title}</strong><p>{feedback.text}</p>{feedback.warnings?.length ? <ul>{feedback.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}</div>
    </div> : null}

    {!accountingReady ? <div className="warning-card"><ShieldCheck size={18} /><div><strong>Comptabilité requise pour rapprocher</strong><p>Les relevés restent consultables, mais un encaissement ou règlement n’est confirmé que si le paiement et son écriture bancaire peuvent être créés ensemble.</p></div><Button variant="secondary" size="small" onClick={onOpenAccounting}>Ouvrir Plan & liaisons</Button></div> : null}

    <div className="bank-summary" aria-label="Résumé bancaire local">
      <article><FileCode2 /><span>Imports</span><strong>{bank.summary.importCount}</strong><small>fichiers locaux</small></article>
      <article><ArrowDownLeft /><span>Entrées clients</span><strong>{bank.summary.bookedCreditCount}</strong><small>crédits BOOK</small></article>
      <article><ArrowUpRight /><span>Sorties fournisseurs</span><strong>{bank.summary.bookedDebitCount}</strong><small>débits BOOK</small></article>
      <article className={bank.summary.unreconciledCount + bank.summary.unreconciledSupplierCount ? 'is-attention' : ''}><Link2 /><span>À rapprocher</span><strong>{bank.summary.unreconciledCount + bank.summary.unreconciledSupplierCount}</strong><small>confirmation requise</small></article>
      <article><Clock3 /><span>En attente</span><strong>{bank.summary.pendingCount}</strong><small>aucune écriture possible</small></article>
    </div>

    {bank.accounts.length ? <section className="bank-accounts" aria-label="Comptes détectés dans les relevés">
      {bank.accounts.map((account) => <article className={account.linked ? 'is-linked' : 'is-unlinked'} key={`${account.accountId}-${account.currency}`}>
        <span>{account.linked ? <ShieldCheck size={18} /> : <Unlink size={18} />}</span>
        <div><strong>{account.linked ? 'Compte associé à cette entreprise' : 'Associer ce compte à cette entreprise'}</strong><p>{account.accountId} · {account.currency} · {account.movementCount} mouvement{account.movementCount > 1 ? 's' : ''}</p><small>{account.linked ? account.linkSource === 'settings_iban' ? 'Correspond à l’IBAN configuré dans Elyko.' : 'Association locale confirmée manuellement.' : 'Le relevé reste visible, mais ses propositions sont bloquées.'}</small></div>
        {!account.linked ? <Button variant="secondary" size="small" disabled={busy || readOnly} onClick={() => void associate(account)}><Link2 size={14} /> Associer ce compte</Button> : account.linkSource === 'explicit' ? <Button variant="ghost" size="small" disabled={busy || readOnly} onClick={() => void dissociate(account)}><Unlink size={14} /> Dissocier</Button> : null}
      </article>)}
    </section> : null}

    <section className="panel bank-movements-panel">
      <SectionHeading eyebrow="Contrôle humain" title="Mouvements bancaires" description="Les propositions facilitent le choix; elles ne valent jamais confirmation." action={<Button variant="ghost" size="small" disabled={busy} onClick={() => void load()}><RefreshCw size={14} /> Actualiser</Button>} />
      <div className="bank-filter-strip" role="tablist" aria-label="Filtrer les mouvements">
        {(Object.keys(filterLabels) as BankMovementFilter[]).map((item) => <button type="button" role="tab" aria-selected={filter === item} className={filter === item ? 'is-active' : ''} key={item} onClick={() => setFilter(item)}>{filterLabels[item]} <em>{counts[item]}</em></button>)}
      </div>
      {movements.length ? <div className="bank-movement-list">
        {movements.map((movement) => {
          const account = accountFor(movement);
          const selectedDocumentId = choices[movement.id] ?? '';
          const candidateQuery = candidateQueries[movement.id] ?? '';
          const supplierDirection = movement.creditDebit === 'DBIT';
          const blockReason = supplierDirection
            ? supplierMovementBlockReason(movement, account, selectedDocumentId, accountingReady)
            : customerMovementBlockReason(movement, account, selectedDocumentId, accountingReady);
          const reconciledInvoice = movement.reconciliation ? workspace.invoices.find((invoice) => invoice.id === movement.reconciliation?.invoiceId) : undefined;
          const reconciledSupplierInvoice = movement.supplierReconciliation ? workspace.supplierInvoices.find((invoice) => invoice.id === movement.supplierReconciliation?.supplierInvoiceId) : undefined;
          return <article className={`bank-movement ${movement.creditDebit === 'DBIT' ? 'is-debit' : 'is-credit'} ${movement.status === 'PDNG' ? 'is-pending' : ''}`} key={movement.id}>
            <div className="bank-movement__direction">{movement.creditDebit === 'DBIT' ? <ArrowUpRight size={19} /> : <ArrowDownLeft size={19} />}</div>
            <div className="bank-movement__identity"><div><strong>{movement.counterpartyName || (movement.creditDebit === 'DBIT' ? 'Bénéficiaire non renseigné' : 'Payeur non renseigné')}</strong><span className={`bank-status bank-status--${movement.status.toLowerCase()}`}>{movement.status === 'BOOK' ? 'Inscrit · BOOK' : 'En attente · PDNG'}</span><span className="bank-status">{supplierDirection ? 'Sortie fournisseur' : 'Entrée client'}</span>{movement.reversal ? <span className="bank-status bank-status--reversal">Extourne</span> : null}</div><p>{formatDate(movement.bookingDate || movement.valueDate)} · {movement.accountId || 'Compte non renseigné'}{movement.counterpartyIban ? ` · ${movement.counterpartyIban}` : ''}</p><small>{referenceLabel(movement.referenceType)} · {movement.reference || movement.unstructured || 'Aucune communication'}</small></div>
            <div className="bank-movement__amount"><strong>{displayMovementAmount(movement)}</strong><small>{movement.valueDate && movement.valueDate !== movement.bookingDate ? `Valeur ${formatDate(movement.valueDate)}` : movement.currency}</small></div>
            <div className="bank-movement__match">
              {movement.reconciliation ? <div className="bank-match-confirmed"><CheckCircle2 size={16} /><span><strong>Rapproché avec {reconciledInvoice?.number || 'une facture'}</strong><small>Confirmé le {formatDateTime(movement.reconciliation.confirmedAt)}</small></span></div>
                : movement.supplierReconciliation ? <div className="bank-match-confirmed"><CheckCircle2 size={16} /><span><strong>Réglé avec {reconciledSupplierInvoice?.reference || 'une facture fournisseur'}</strong><small>Confirmé le {formatDateTime(movement.supplierReconciliation.confirmedAt)}</small></span></div>
                  : movement.reversal ? <div className="bank-match-muted"><span>Extourne conservée pour contrôle; aucun paiement proposé.</span></div>
                  : movement.status === 'PDNG' ? <div className="bank-match-muted"><Clock3 size={15} /><span>Attendez le statut BOOK avant tout rapprochement.</span></div>
                    : !account?.linked ? <div className="bank-match-warning"><Unlink size={15} /><span>Compte non associé. Confirmez d’abord qu’il appartient à votre entreprise.</span></div>
                      : supplierDirection ? <>
                        <div className={`bank-suggestion bank-suggestion--${movement.supplierSuggestion.kind === 'supplier_match' ? 'automatic_exact' : movement.supplierSuggestion.kind}`}><span>{supplierSuggestionLabels[movement.supplierSuggestion.kind]}</span><p>{movement.supplierSuggestion.reason || 'Aucune facture fournisseur suffisamment sûre n’a été trouvée.'}</p></div>
                        {movement.supplierSuggestion.candidates.length ? <BankSupplierCandidatePicker
                          movement={movement}
                          workspace={workspace}
                          selectedSupplierInvoiceId={selectedDocumentId}
                          query={candidateQuery}
                          onQueryChange={(value) => {
                            setCandidateQueries((current) => ({ ...current, [movement.id]: value }));
                            if (selectedDocumentId && !filterBankSupplierCandidates(movement, workspace.supplierInvoices, workspace.suppliers, value).some((item) => item.candidate.supplierInvoiceId === selectedDocumentId)) {
                              setChoices((current) => ({ ...current, [movement.id]: '' }));
                            }
                          }}
                          onSelect={(supplierInvoiceId) => setChoices((current) => ({ ...current, [movement.id]: supplierInvoiceId }))}
                        /> : null}
                        <Button size="small" disabled={busy || readOnly || Boolean(blockReason) || !canConfirmSupplierBankReconciliation(movement, selectedDocumentId)} title={readOnly ? 'Licence en lecture seule' : blockReason || 'Créer le règlement fournisseur après confirmation'} onClick={() => void confirmSupplierMovement(movement)}><Link2 size={14} /> Confirmer le règlement</Button>
                        {blockReason ? <small className="bank-block-reason">{blockReason}</small> : null}
                      </> : <>
                        <div className={`bank-suggestion bank-suggestion--${movement.suggestion.kind}`}><span>{suggestionLabels[movement.suggestion.kind]}</span><p>{movement.suggestion.reason || 'Aucune correspondance suffisamment sûre n’a été trouvée.'}</p></div>
                        {movement.suggestion.candidates.length ? <BankCandidatePicker
                          movement={movement}
                          workspace={workspace}
                          selectedInvoiceId={selectedDocumentId}
                          query={candidateQuery}
                          onQueryChange={(value) => {
                            setCandidateQueries((current) => ({ ...current, [movement.id]: value }));
                            if (selectedDocumentId && !filterBankCandidates(movement, workspace.invoices, workspace.clients, value).some((item) => item.candidate.invoiceId === selectedDocumentId)) {
                              setChoices((current) => ({ ...current, [movement.id]: '' }));
                            }
                          }}
                          onSelect={(invoiceId) => setChoices((current) => ({ ...current, [movement.id]: invoiceId }))}
                        /> : null}
                        <Button size="small" disabled={busy || readOnly || Boolean(blockReason) || !canConfirmBankReconciliation(movement, selectedDocumentId)} title={readOnly ? 'Licence en lecture seule' : blockReason || 'Créer le paiement après confirmation'} onClick={() => void confirmMovement(movement)}><Link2 size={14} /> Confirmer l’encaissement</Button>
                        {blockReason ? <small className="bank-block-reason">{blockReason}</small> : null}
                      </>}
            </div>
          </article>;
        })}
      </div> : <EmptyState icon={filter === 'reconciled' ? <CheckCircle2 /> : filter === 'pending' ? <Clock3 /> : <Link2 />} title={`Aucun mouvement « ${filterLabels[filter].toLowerCase()} »`} text={bank.imports.length ? 'Changez de filtre ou importez un relevé plus récent.' : 'Importez votre premier XML CAMT fourni par votre banque. Aucun fichier d’exemple n’est ajouté.'} actionLabel={bank.imports.length || readOnly ? undefined : 'Importer un relevé XML'} onAction={bank.imports.length || readOnly ? undefined : () => void importStatement()} />}
    </section>

    <section className="panel bank-imports-panel">
      <SectionHeading eyebrow="Traçabilité locale" title="Historique des imports" description="Empreinte, type CAMT, compte et nombre d’entrées restent consultables sur ce PC." />
      {bank.imports.length ? <div className="bank-import-list">{bank.imports.map((item) => <article key={item.id}>
        <span><History size={17} /></span>
        <div className="bank-import-list__identity"><strong>{item.sourceName}</strong><p>{item.messageType || 'CAMT'}{item.namespaceVersion ? ` · ${item.namespaceVersion}` : ''} · {item.accountId || 'Compte non renseigné'}</p>{item.fileSha256 ? <div className="bank-import-hash" title={`SHA-256 ${item.fileSha256}`}><small>SHA-256</small><code>{shortSha256(item.fileSha256)}</code><button type="button" onClick={() => void copyImportFingerprint(item.fileSha256)} aria-label={`Copier l’empreinte SHA-256 du fichier ${item.sourceName}`}><Copy size={12} /></button></div> : null}</div>
        <div><strong>{item.importedCount}</strong><small>mouvement{item.importedCount > 1 ? 's' : ''} importé{item.importedCount > 1 ? 's' : ''} sur {item.entryCount}{item.ignoredCount ? ` · ${item.ignoredCount} ignoré${item.ignoredCount > 1 ? 's' : ''}` : ' · aucun ignoré'}</small></div>
        <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
      </article>)}</div> : <p className="bank-imports-empty">Aucun relevé importé.</p>}
    </section>
  </div>;
}
