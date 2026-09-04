import type { Invoice, Workspace } from './types';

export type GettingStartedStepId =
  | 'client'
  | 'project'
  | 'quote'
  | 'invoice'
  | 'payment'
  | 'backup';

export type GettingStartedView =
  | 'clients'
  | 'projects'
  | 'quotes'
  | 'invoices'
  | 'accounting'
  | 'settings';

export type GettingStartedActionKind =
  | 'create_client'
  | 'create_project'
  | 'create_quote'
  | 'configure_billing'
  | 'review_quotes'
  | 'convert_quote'
  | 'review_invoice'
  | 'configure_accounting'
  | 'record_payment'
  | 'review_accounting'
  | 'create_backup';

export type GettingStartedAction = {
  kind: GettingStartedActionKind;
  view: GettingStartedView;
  label: string;
  readOnlyLabel: string;
  description: string;
  entityId?: string;
};

export type GettingStartedStep = {
  id: GettingStartedStepId;
  title: string;
  description: string;
  complete: boolean;
};

export type GettingStartedJourney = {
  steps: GettingStartedStep[];
  completedCount: number;
  totalCount: number;
  percent: number;
  complete: boolean;
  nextStep: GettingStartedStep | null;
  nextAction: GettingStartedAction | null;
};

const issuedInvoiceStatuses = new Set<Invoice['status']>([
  'issued',
  'partially_paid',
  'paid',
]);

function hasText(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function isIssuedCustomerInvoice(invoice: Invoice) {
  return invoice.type !== 'credit_note'
    && issuedInvoiceStatuses.has(invoice.status)
    && hasText(invoice.number);
}

function hasVerifiedPaymentPosting(
  workspace: Workspace,
  eligibleInvoiceIds: ReadonlySet<string>,
) {
  return workspace.payments.some((payment) =>
    eligibleInvoiceIds.has(payment.invoiceId)
    && payment.amountCents > 0
    && hasText(payment.journalEntryId)
    && payment.journalEntryIsActive === true
    && payment.journalEntrySemanticallyValid === true,
  );
}

function customerPaymentAccountingReady(workspace: Workspace) {
  const accounting = workspace.accountingSettings;
  return Boolean(
    accounting?.enabled
    && hasText(accounting.arAccountId)
    && hasText(accounting.bankAccountId),
  );
}

function acceptedQuoteIds(workspace: Workspace) {
  const activeClientIds = new Set(
    workspace.clients
      .filter((client) => !client.archivedAt)
      .map((client) => client.id),
  );
  return new Set(
    workspace.quotes
      .filter((quote) =>
        quote.status === 'accepted'
        && hasText(quote.number)
        && activeClientIds.has(quote.clientId),
      )
      .map((quote) => quote.id),
  );
}

function linkedIssuedInvoiceIds(workspace: Workspace) {
  const quoteIds = acceptedQuoteIds(workspace);
  return new Set(
    workspace.invoices
      .filter((invoice) =>
        isIssuedCustomerInvoice(invoice)
        && Boolean(invoice.quoteId)
        && quoteIds.has(invoice.quoteId ?? ''),
      )
      .map((invoice) => invoice.id),
  );
}

function firstOpenInvoice(workspace: Workspace) {
  const invoiceIds = linkedIssuedInvoiceIds(workspace);
  return workspace.invoices.find((invoice) =>
    invoiceIds.has(invoice.id)
    && ['issued', 'partially_paid'].includes(invoice.status),
  );
}

function nextActionFor(
  stepId: GettingStartedStepId,
  workspace: Workspace,
): GettingStartedAction {
  if (stepId === 'client') {
    return {
      kind: 'create_client',
      view: 'clients',
      label: 'Ajouter mon premier client',
      readOnlyLabel: 'Voir les clients',
      description: 'Commencez par les coordonnées réelles du client à facturer.',
    };
  }

  if (stepId === 'project') {
    return {
      kind: 'create_project',
      view: 'projects',
      label: 'Créer le premier projet',
      readOnlyLabel: 'Voir les projets',
      description: 'Rattachez l’activité au client avant de préparer les documents.',
    };
  }

  if (stepId === 'quote') {
    if (workspace.settings?.setupDeferred?.billing) {
      return {
        kind: 'configure_billing',
        view: 'settings',
        label: 'Finaliser la facturation',
        readOnlyLabel: 'Voir les réglages de facturation',
        description: 'Confirmez l’IBAN, la numérotation et les délais avant le premier devis.',
      };
    }
    const quoteToReview = workspace.quotes.find((quote) =>
      quote.status === 'draft' || quote.status === 'issued',
    );
    return quoteToReview
      ? {
          kind: 'review_quotes',
          view: 'quotes',
          entityId: quoteToReview.id,
          label: quoteToReview.status === 'draft'
            ? 'Finaliser le devis en cours'
            : 'Enregistrer la décision du client',
          readOnlyLabel: 'Voir le devis en cours',
          description: quoteToReview.status === 'draft'
            ? 'Émettez le brouillon lorsqu’il correspond à votre offre réelle.'
            : 'Marquez le devis accepté uniquement après la réponse du client.',
        }
      : {
          kind: 'create_quote',
          view: 'quotes',
          label: 'Créer le premier devis',
          readOnlyLabel: 'Voir les devis',
          description: 'Préparez les prestations, prix et conditions convenus.',
        };
  }

  if (stepId === 'invoice') {
    const quoteIds = acceptedQuoteIds(workspace);
    const draft = workspace.invoices.find((invoice) =>
      invoice.type !== 'credit_note'
      && invoice.status === 'draft'
      && Boolean(invoice.quoteId)
      && quoteIds.has(invoice.quoteId ?? ''),
    );
    return draft
      ? {
          kind: 'review_invoice',
          view: 'invoices',
          entityId: draft.id,
          label: 'Émettre la facture préparée',
          readOnlyLabel: 'Voir la facture préparée',
          description: 'Contrôlez les dates, montants et coordonnées avant émission.',
        }
      : {
          kind: 'convert_quote',
          view: 'quotes',
          label: 'Transformer le devis accepté',
          readOnlyLabel: 'Voir le devis accepté',
          description: 'Créez la facture liée sans ressaisir les lignes du devis.',
        };
  }

  if (stepId === 'payment') {
    if (!customerPaymentAccountingReady(workspace)) {
      return {
        kind: 'configure_accounting',
        view: 'accounting',
        label: 'Préparer la comptabilité',
        readOnlyLabel: 'Voir la configuration comptable',
        description: 'Activez les comptes clients et banque avant tout encaissement.',
      };
    }
    const invoice = firstOpenInvoice(workspace);
    return invoice
      ? {
          kind: 'record_payment',
          view: 'invoices',
          entityId: invoice.id,
          label: 'Enregistrer le premier paiement',
          readOnlyLabel: 'Voir la facture à encaisser',
          description: 'Le règlement et son écriture comptable seront créés ensemble.',
        }
      : {
          kind: 'review_accounting',
          view: 'accounting',
          label: 'Contrôler l’encaissement',
          readOnlyLabel: 'Voir la comptabilité',
          description: 'La facture est soldée, mais aucune écriture active et vérifiée ne le prouve.',
        };
  }

  return {
    kind: 'create_backup',
    view: 'settings',
    label: 'Créer la première sauvegarde',
    readOnlyLabel: 'Voir les sauvegardes',
    description: 'Conservez une archive récente dans l’emplacement sûr que vous avez choisi.',
  };
}

export function buildGettingStartedJourney(workspace: Workspace): GettingStartedJourney {
  const activeClientIds = new Set(
    workspace.clients
      .filter((client) => !client.archivedAt)
      .map((client) => client.id),
  );
  const quoteIds = acceptedQuoteIds(workspace);
  const invoiceIds = linkedIssuedInvoiceIds(workspace);
  const steps: GettingStartedStep[] = [
    {
      id: 'client',
      title: 'Client réel',
      description: 'Une fiche client active est enregistrée.',
      complete: activeClientIds.size > 0,
    },
    {
      id: 'project',
      title: 'Projet suivi',
      description: 'Un projet non archivé est lié à l’activité.',
      complete: workspace.projects.some((project) =>
        !project.archivedAt && activeClientIds.has(project.clientId),
      ),
    },
    {
      id: 'quote',
      title: 'Devis accepté',
      description: 'La réponse réelle du client est enregistrée.',
      complete: quoteIds.size > 0,
    },
    {
      id: 'invoice',
      title: 'Facture émise',
      description: 'Une facture numérotée issue du devis accepté a été émise.',
      complete: invoiceIds.size > 0,
    },
    {
      id: 'payment',
      title: 'Encaissement comptabilisé',
      description: 'Cette facture possède un paiement et une écriture active vérifiée.',
      complete: hasVerifiedPaymentPosting(workspace, invoiceIds),
    },
    {
      id: 'backup',
      title: 'Sauvegarde créée',
      description: 'Une archive locale réussie et son chemin sont enregistrés.',
      complete: hasText(workspace.backupStatus.lastSuccessAt)
        && hasText(workspace.backupStatus.lastPath),
    },
  ];
  const completedCount = steps.filter((step) => step.complete).length;
  const nextStep = steps.find((step) => !step.complete) ?? null;
  const complete = nextStep === null;

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    percent: Math.round((completedCount / steps.length) * 100),
    complete,
    nextStep,
    nextAction: nextStep ? nextActionFor(nextStep.id, workspace) : null,
  };
}
