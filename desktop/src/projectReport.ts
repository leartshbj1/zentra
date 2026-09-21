import type { Project, Workspace } from './types';
import {
  documentTotals,
  formatMinutes,
  formatMoney,
  invoiceOpenBalance,
  projectFinancials,
} from './utils';
import { salesTotalsByCurrency, formatSalesTotals } from './salesFinancials';
export const reportSections = {
  overview: 'Vue d’ensemble',
  sales: 'Devis et factures',
  purchases: 'Achats et dépenses',
  time: 'Heures et équipe',
  planning: 'Planning et rendez-vous',
  documents: 'Documents et notes',
} as const;
export type ReportSectionKey = keyof typeof reportSections;
export type ProjectReport = {
  title: string;
  subtitle: string;
  sections: { title: string; headers: string[]; rows: string[][] }[];
};
const statuses: Record<string, string> = {
  draft: 'Brouillon',
  issued: 'Émise',
  accepted: 'Accepté',
  paid: 'Payée',
  partially_paid: 'Paiement partiel',
  cancelled: 'Annulé',
  validated: 'Validée',
  planned: 'Prévu',
  in_progress: 'En cours',
  paused: 'En pause',
  completed: 'Terminé',
  closed: 'Clôturé',
  todo: 'À faire',
  done: 'Terminé',
  scheduled: 'Prévu',
  entered: 'Saisi',
  approved: 'Approuvé',
  locked: 'Verrouillé',
  refused: 'Refusé',
  expired: 'Expiré',
  pending: 'À payer',
  partial: 'Paiement partiel',
};
const status = (v: string) => statuses[v] || v;
export function buildProjectReport(
  w: Workspace,
  p: Project,
  selected: ReportSectionKey[],
): ProjectReport {
  const client = w.clients.find((c) => c.id === p.clientId),
    invoices = w.invoices.filter((i) => i.projectId === p.id),
    quotes = w.quotes.filter((q) => q.projectId === p.id);
  const s = projectFinancials(
    p,
    w.invoices,
    w.payments,
    w.timeEntries,
    w.expenses,
    w.supplierInvoices,
    w.supplierCreditNotes,
  );
  const sections: ProjectReport['sections'] = [];
  const add = (title: string, headers: string[], rows: string[][]) =>
    sections.push({ title, headers, rows });
  if (selected.includes('overview')) {
    add(
      'Le projet',
      ['Information', 'Détail'],
      [
        ['Client', client?.name || 'Non renseigné'],
        [
          'Contact',
          [client?.contactPerson, client?.email, client?.phone]
            .filter(Boolean)
            .join(' · ') || 'Non renseigné',
        ],
        ['Adresse', p.address || 'Non renseignée'],
        ['Statut', status(p.status)],
        ['Dates prévues', `${p.plannedStart || '—'} / ${p.plannedEnd || '—'}`],
        ['Dates réelles', `${p.actualStart || '—'} / ${p.actualEnd || '—'}`],
        ['Budget', formatMoney(p.budgetCents)],
        ['Heures prévues', formatMinutes(p.plannedMinutes || 0)],
      ],
    );
    add(
      'Situation financière',
      ['Indicateur', 'Montant'],
      [
        ['Facturé hors TVA · avoirs déduits', s.invoicedNetLabel],
        ['Facturé TTC', s.invoicedTotalLabel],
        [
          'Paiements reçus',
          formatSalesTotals(
            salesTotalsByCurrency(invoices, w.payments),
            'paidCents',
          ),
        ],
        [
          'Reste à recevoir',
          formatSalesTotals(
            salesTotalsByCurrency(invoices, w.payments),
            'openCents',
          ),
        ],
        ['Main-d’œuvre', formatMoney(s.laborCost)],
        ['Coût des achats après avoirs', formatMoney(s.expenseNet)],
        ['Dont TVA non déductible', formatMoney(s.nonDeductibleVatCost)],
        [
          'Marge de gestion',
          s.marginUnavailableReason || formatMoney(s.margin),
        ],
        [
          'Méthode',
          'Recettes : factures émises uniquement. Coûts : achats validés et dépenses à payer inclus. Devis et brouillons exclus de la marge. Devises séparées, sans conversion implicite.',
        ],
      ],
    );
  }
  if (selected.includes('sales')) {
    add(
      'Devis',
      ['Document', 'Date / statut', 'Total TTC'],
      quotes.map((q) => [
        `${q.number} · ${q.title}\n${q.creator?.name || ''}`,
        `${q.issueDate}\n${status(q.status)}`,
        formatMoney(documentTotals(q.lines).totalCents, q.currency),
      ]),
    );
    add(
      'Factures et avoirs',
      ['Document', 'Date / statut', 'Total / reste TTC'],
      invoices.map((i) => [
        `${i.number} · ${i.title}\n${i.creator?.name || ''}`,
        `${i.issueDate}\n${status(i.status)}\nÉchéance ${i.dueDate}`,
        `${formatMoney(documentTotals(i.lines).totalCents, i.currency)}\nReste ${i.type === 'credit_note' || ['draft', 'cancelled'].includes(i.status) ? '—' : formatMoney(invoiceOpenBalance(i, w.invoices, w.payments), i.currency)}`,
      ]),
    );
    for (const doc of [...quotes, ...invoices])
      add(
        `Détail ${doc.number || doc.title || 'Brouillon'}`,
        ['Prestation', 'Quantité', 'Hors TVA'],
        doc.lines.map((l) => [
          l.description,
          String(l.quantity),
          formatMoney(documentTotals([l]).netCents, doc.currency),
        ]),
      );
    const ids = new Set(invoices.map((i) => i.id));
    add(
      'Encaissements',
      ['Facture', 'Date', 'Montant'],
      w.payments
        .filter((p) => ids.has(p.invoiceId))
        .map((p) => [
          invoices.find((i) => i.id === p.invoiceId)?.number || '',
          p.date,
          formatMoney(
            p.amountCents,
            invoices.find((i) => i.id === p.invoiceId)?.currency,
          ),
        ]),
    );
  }
  if (selected.includes('purchases')) {
    const rows: string[][] = [];
    for (const i of w.supplierInvoices)
      for (const l of i.lines.filter(
        (l) => (l.projectId ?? i.projectId) === p.id,
      ))
        rows.push([
          `${i.supplierName} · ${i.reference}\n${l.description}`,
          `${i.documentDate}\n${status(i.documentStatus)}`,
          formatMoney(l.costCents ?? l.netCents),
        ]);
    for (const e of w.expenses.filter((e) => e.projectId === p.id))
      rows.push([
        `${e.supplier} · ${e.reference}\n${e.category}\n${e.note}`,
        `${e.date}\n${status(e.paymentStatus)}`,
        formatMoney(e.costCents ?? e.netCents),
      ]);
    add(
      'Achats et dépenses affectés au projet',
      ['Fournisseur / objet', 'Date / statut', 'Coût'],
      rows,
    );
    add(
      'Avoirs fournisseurs',
      ['Référence', 'Statut', 'Coût à déduire'],
      w.supplierCreditNotes.flatMap((c) =>
        c.items
          .filter((l) => l.projectId === p.id)
          .map((l) => [
            c.reference,
            status(c.status),
            formatMoney(l.costCents ?? l.netCents),
          ]),
      ),
    );
  }
  if (selected.includes('time'))
    add(
      'Heures et équipe',
      ['Collaborateur / travail', 'Date', 'Durée / coût'],
      w.timeEntries
        .filter((e) => e.projectId === p.id)
        .map((e) => {
          const person = w.employees.find((p) => p.id === e.employeeId);
          return [
            (person?.name || 'Collaborateur') + '\n' + e.note,
            `${e.date}\n${status(e.status)}`,
            `${formatMinutes(e.minutes)}\n${formatMoney(Math.round((e.minutes * e.hourlyCostCents) / 60))}`,
          ];
        }),
    );
  if (selected.includes('planning')) {
    add(
      'Étapes et tâches',
      ['Objet', 'Échéance', 'État'],
      [...w.projectMilestones, ...w.projectTasks]
        .filter((t) => t.projectId === p.id)
        .map((t) => [
          `${t.title}\n${t.description}`,
          t.dueDate,
          status(t.status),
        ]),
    );
    add(
      'Rendez-vous',
      ['Objet / lieu', 'Dates', 'État'],
      w.agendaEvents
        .filter((e) => e.projectId === p.id)
        .map((e) => [
          `${e.title}\n${e.location}\n${e.notes}`,
          `${e.startDate} ${e.startTime || ''}\n${e.endDate} ${e.endTime || ''}`,
          status(e.status),
        ]),
    );
  }
  if (selected.includes('documents')) {
    add(
      'Documents du projet',
      ['Fichier', 'Type', 'Ajouté le'],
      (w.attachments ?? [])
        .filter((a) => a.projectId === p.id)
        .map((a) => [a.originalName, a.mimeType, a.createdAt.slice(0, 10)]),
    );
    add('Notes du projet', ['Notes'], [[p.notes || 'Aucune note']]);
  }
  return {
    title: p.name,
    subtitle: `Rapport de projet · ${new Date().toLocaleDateString('fr-CH')} · Situation enregistrée dans Zentra`,
    sections,
  };
}
