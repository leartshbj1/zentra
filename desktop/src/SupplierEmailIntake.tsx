import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileSearch2,
  MailCheck,
  Paperclip,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { desktopApi } from './bridge';
import {
  supplierEmailDraftIssues,
  supplierEmailDuplicateId,
  supplierEmailImportPayload,
  type SupplierEmailImportDraft,
  type SupplierEmailInspection,
} from './supplierEmail';
import type { Workspace } from './types';
import { centsFromInput, errorMessage, formatMoney } from './utils';
import { Button, Field, FormActions, Modal } from './ui';
import './SupplierEmailIntake.css';

type RunAction = (
  action: () => Promise<Workspace>,
  successMessage: string,
  close?: boolean,
) => Promise<boolean>;

function inferredVatRate(
  inspection: SupplierEmailInspection,
  configuredRates: number[],
) {
  if (inspection.netCents && inspection.vatCents !== null) {
    const inferred = Math.round((inspection.vatCents * 10_000) / inspection.netCents);
    const match = configuredRates.find((rate) => Math.abs(rate - inferred) <= 2);
    if (match !== undefined) return match;
  }
  return configuredRates.includes(0) ? 0 : configuredRates[0] || 0;
}

function initialDraft(
  inspection: SupplierEmailInspection,
  workspace: Workspace,
): SupplierEmailImportDraft {
  const vatRates = workspace.settings?.organization.vatRegistered
    ? [...new Set([0, ...(workspace.settings.billing.vatRatesBp || [])])]
    : [0];
  return {
    supplierId: inspection.matchedSupplierId || '',
    projectId: '',
    reference: inspection.reference,
    documentDate: inspection.documentDate,
    dueDate: inspection.dueDate,
    totalCents: inspection.totalCents || 0,
    currency: inspection.currency,
    vatBp: inferredVatRate(inspection, vatRates),
    category: workspace.settings?.work.costCategories[0] || '',
    expenseAccountId: workspace.accountingSettings?.expenseAccountId || '',
    description: inspection.subject || `Facture ${inspection.reference}`,
  };
}

export function SupplierEmailIntake({
  workspace,
  busy,
  readOnly,
  runAction,
}: {
  workspace: Workspace;
  busy: boolean;
  readOnly: boolean;
  runAction: RunAction;
}) {
  const [inspection, setInspection] = useState<SupplierEmailInspection | null>(null);
  const [draft, setDraft] = useState<SupplierEmailImportDraft | null>(null);
  const [totalText, setTotalText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [manualInvoiceConfirmation, setManualInvoiceConfirmation] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState('');
  const effectiveInspection = inspection
    ? { ...inspection, invoiceSignal: inspection.invoiceSignal || manualInvoiceConfirmation }
    : null;
  const issues = useMemo(
    () =>
      draft && effectiveInspection
        ? supplierEmailDraftIssues(draft, effectiveInspection, workspace)
        : [],
    [draft, effectiveInspection, workspace],
  );
  const duplicateInvoiceId = draft
    ? supplierEmailDuplicateId(draft, workspace)
    : null;

  async function chooseMessage() {
    setError('');
    setLocalBusy(true);
    try {
      const path = await desktopApi.chooseSupplierEmailFile();
      if (!path) return;
      const result = await desktopApi.inspectSupplierEmailFile(path);
      setInspection(result);
      setDraft(initialDraft(result, workspace));
      setTotalText(result.totalCents ? (result.totalCents / 100).toFixed(2) : '');
      setConfirmed(false);
      setManualInvoiceConfirmation(false);
    } catch (reason) {
      setError(
        errorMessage(reason, "L'e-mail n'a pas pu être analysé localement."),
      );
    } finally {
      setLocalBusy(false);
    }
  }

  function close() {
    setInspection(null);
    setDraft(null);
    setTotalText('');
    setConfirmed(false);
    setManualInvoiceConfirmation(false);
    setError('');
  }

  async function save() {
    if (!draft || !effectiveInspection || issues.length || !confirmed) return;
    const success = await runAction(
      () =>
        desktopApi.saveSupplierInvoiceDraft(
          supplierEmailImportPayload(draft, effectiveInspection),
        ),
      "Le message a créé un brouillon fournisseur. Ouvrez-le, joignez le PDF original puis validez-le pour l'enregistrer en comptabilité.",
      false,
    );
    if (success) close();
  }

  const vatRates = workspace.settings?.organization.vatRegistered
    ? [...new Set([0, ...(workspace.settings.billing.vatRatesBp || [])])]
    : [0];

  return (
    <section className="supplier-email-intake" aria-label="Import des factures reçues par e-mail">
      <div className="supplier-email-intake__icon"><MailCheck size={22} /></div>
      <div className="supplier-email-intake__copy">
        <strong>Facture reçue par e-mail ?</strong>
        <p>
          Exportez le message en <code>.eml</code>. Zentra repère localement
          l’expéditeur, la référence, les dates et le total avec des règles
          déterministes, sans IA et sans connexion à votre boîte mail.
        </p>
      </div>
      <Button
        variant="secondary"
        disabled={busy || localBusy || readOnly}
        onClick={() => void chooseMessage()}
      >
        <Upload size={15} /> {localBusy ? 'Analyse…' : 'Importer un e-mail'}
      </Button>
      {error ? <p className="supplier-email-intake__error" role="alert">{error}</p> : null}

      {inspection && draft ? (
        <Modal
          title="Contrôler la facture reçue"
          description="Trois étapes courtes. Rien n’est validé ni payé automatiquement."
          onClose={close}
          wide
        >
          <form
            className="supplier-email-review-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
          <div className="supplier-email-steps" aria-label="Étapes de l'import">
            <span className="is-complete"><CheckCircle2 size={15} /> 1 · Message analysé</span>
            <span className={issues.length ? 'is-current' : 'is-complete'}><FileSearch2 size={15} /> 2 · Données contrôlées</span>
            <span className={!issues.length && confirmed ? 'is-current' : ''}><ShieldCheck size={15} /> 3 · Brouillon local</span>
          </div>

          <section className="supplier-email-source">
            <div>
              <small>Message local</small>
              <strong>{inspection.fileName}</strong>
              <span>{inspection.subject || 'Objet non détecté'}</span>
            </div>
            <div>
              <small>Expéditeur</small>
              <strong>{inspection.senderName || inspection.senderEmail || 'Non détecté'}</strong>
              <span>{inspection.senderEmail}</span>
            </div>
            <div>
              <small>Pièces annoncées</small>
              <strong>{inspection.attachmentNames.length}</strong>
              <span>{inspection.attachmentNames.join(', ') || 'Aucune pièce reconnue'}</span>
            </div>
            <span className={`supplier-email-confidence is-${inspection.confidence}`}>
              Confiance {inspection.confidence === 'high' ? 'élevée' : inspection.confidence === 'medium' ? 'moyenne' : 'faible'}
            </span>
          </section>

          {!inspection.invoiceSignal ? (
            <label className="supplier-email-confirm-warning">
              <input
                type="checkbox"
                checked={manualInvoiceConfirmation}
                onChange={(event) => setManualInvoiceConfirmation(event.target.checked)}
              />
              <span><AlertTriangle size={17} /> Le message n’a pas été reconnu avec certitude. Je confirme avoir ouvert la pièce et vérifié qu’il s’agit d’une facture.</span>
            </label>
          ) : null}

          {duplicateInvoiceId ? (
            <div className="report-callout is-warning">
              <AlertTriangle size={19} />
              <div><strong>Doublon bloqué</strong><p>Une facture de ce fournisseur possède déjà la référence {draft.reference}. Ouvrez l’existant au lieu de l’importer de nouveau.</p></div>
            </div>
          ) : null}

          <div className="form-grid supplier-email-form">
            <Field label="Fournisseur" required>
              <select value={draft.supplierId} onChange={(event) => setDraft({ ...draft, supplierId: event.target.value })}>
                <option value="">Choisir…</option>
                {workspace.suppliers.filter((supplier) => !supplier.archivedAt).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </Field>
            <Field label="Référence" required>
              <input value={draft.reference} onChange={(event) => setDraft({ ...draft, reference: event.target.value })} />
            </Field>
            <Field label="Date de facture" required>
              <input type="date" value={draft.documentDate} onChange={(event) => setDraft({ ...draft, documentDate: event.target.value })} />
            </Field>
            <Field label="Échéance" required>
              <input type="date" min={draft.documentDate || undefined} value={draft.dueDate} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })} />
            </Field>
            <Field label="Total TTC · CHF" required hint={draft.totalCents ? `Montant contrôlé : ${formatMoney(draft.totalCents)}` : undefined}>
              <input type="number" min="0.01" step="0.01" value={totalText} onChange={(event) => { setTotalText(event.target.value); setDraft({ ...draft, totalCents: centsFromInput(event.target.value) }); }} />
            </Field>
            <Field label="Devise" required>
              <select value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}>
                <option value="">À contrôler…</option>
                <option value="CHF">CHF</option>
                {draft.currency && draft.currency !== 'CHF' ? <option value={draft.currency} disabled>{draft.currency} · non pris en charge</option> : null}
              </select>
            </Field>
            <Field label="TVA" required>
              <select value={draft.vatBp} onChange={(event) => setDraft({ ...draft, vatBp: Number(event.target.value) })}>
                {vatRates.map((rate) => <option key={rate} value={rate}>{(rate / 100).toLocaleString('fr-CH')} %</option>)}
              </select>
            </Field>
            <Field label="Catégorie" required>
              <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
                <option value="">Choisir…</option>
                {(workspace.settings?.work.costCategories || []).map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </Field>
            <Field label="Projet / chantier">
              <select value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}>
                <option value="">Aucun</option>
                {workspace.projects.filter((project) => project.status !== 'closed').map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </Field>
            <Field label="Libellé comptable" wide required>
              <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </Field>
          </div>

          {issues.length ? (
            <div className="supplier-email-issues" role="alert">
              <strong><AlertTriangle size={16} /> À compléter avant l’import</strong>
              <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            </div>
          ) : (
            <div className="supplier-email-ready"><CheckCircle2 size={18} /><span>Les champs obligatoires sont cohérents. La facture restera en brouillon jusqu’à votre validation comptable.</span></div>
          )}

          <label className="supplier-email-final-check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>J’ai contrôlé la pièce jointe, le fournisseur, les dates, le montant et la TVA.</span>
          </label>
          <div className="supplier-email-proof"><Paperclip size={15} /><span>Le nom du message, son Message-ID et son empreinte SHA-256 seront inscrits dans la note du brouillon. Joignez ensuite le PDF original.</span></div>
          <FormActions
            onCancel={close}
            busy={busy || localBusy}
            disabled={issues.length > 0 || !confirmed}
            submitLabel="Créer le brouillon"
          />
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
