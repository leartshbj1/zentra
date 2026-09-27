import type { Project, Workspace } from './types';
import {
  documentTotals,
  formatMinutes,
  formatMoney,
  invoiceOpenBalance,
  projectFinancials,
} from './utils';
import { salesTotalsByCurrency, formatSalesTotals } from './salesFinancials';
import { getAppLocale, t } from './language';
export const reportSections = {
  overview: 'Vue d’ensemble',
  sales: 'Devis et factures',
  purchases: 'Achats et dépenses',
  time: 'Heures et équipe',
  planning: 'Planning et rendez-vous',
  documents: 'Documents et notes',
} as const;
export type ReportSectionKey = keyof typeof reportSections;
export const reportPresets = {
  summary: { label: 'Synthèse', description: 'Le projet et ses principaux montants, en quelques pages.', sections: ['overview'] },
  client: { label: 'Dossier client', description: 'Documents émis et avancement. Coûts internes, notes et brouillons exclus.', sections: ['overview', 'sales', 'planning'] },
  internal: { label: 'Dossier interne', description: 'Le suivi complet : ventes, achats, heures, planning et notes.', sections: Object.keys(reportSections) },
} as const;
export type ReportPreset = keyof typeof reportPresets;
export type ProjectReportOptions = { preset?: ReportPreset; author?: string; createdAt?: Date };

/** Most recently recorded activity first; planned future dates are not activity. */
export function recentReportProjects(w: Workspace): Project[] {
  const latest = new Map<string, number>();
  const record = (id: string | null | undefined, date: string | undefined) => {
    const value = date ? Date.parse(date) : NaN;
    if (id && Number.isFinite(value)) latest.set(id, Math.max(latest.get(id) ?? 0, value));
  };
  for (const item of [...w.quotes, ...w.invoices]) record(item.projectId, item.createdAt || item.issueDate);
  for (const item of [...w.projectTasks, ...w.projectMilestones]) record(item.projectId, item.updatedAt || item.createdAt);
  for (const item of w.attachments ?? []) record(item.projectId, item.createdAt);
  for (const item of w.timeEntries) record(item.projectId, item.date);
  for (const item of w.expenses) record(item.projectId, item.date);
  return [...w.projects].sort((a,b) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0) || a.name.localeCompare(b.name, getAppLocale()) || a.id.localeCompare(b.id));
}
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
const status = (v: string) => typeof v === 'string' && v.trim() ? t(statuses[v] || v) : t('Non renseigné');
export function buildProjectReport(
  w: Workspace,
  p: Project,
  selected: ReportSectionKey[],
  options: ProjectReportOptions = {},
): ProjectReport {
  const forClient = options.preset === 'client';
  const included = forClient ? selected.filter(key => reportPresets.client.sections.some(allowed => allowed === key)) : selected;
  const client = w.clients.find((c) => c.id === p.clientId),
    invoices = w.invoices.filter((i) => i.projectId === p.id && (!forClient || !['draft','cancelled'].includes(i.status))),
    quotes = w.quotes.filter((q) => q.projectId === p.id && (!forClient || !['draft','cancelled'].includes(q.status)));
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
    sections.push({ title: t(title), headers: headers.map(h => t(h)), rows: rows.length ? rows : [headers.map((_,i) => i === 0 ? t('Aucune donnée enregistrée') : '')] });
  if (included.includes('overview')) {
    add(
      'Le projet',
      ['Information', 'Détail'],
      [
        [t('Client'), client?.company || client?.name || t('Non renseigné')],
        [
          t('Contact'),
          [client?.contactPerson, client?.email, client?.phone]
            .filter(Boolean)
            .join(' · ') || t('Non renseigné'),
        ],
        [t('Adresse'), p.address || t('Non renseignée')],
        [t('Statut'), status(p.status)],
        [t('Dates prévues'), `${p.plannedStart || '—'} / ${p.plannedEnd || '—'}`],
        [t('Dates réelles'), `${p.actualStart || '—'} / ${p.actualEnd || '—'}`],
        ...(!forClient ? [[t('Budget'), p.budgetCents ? formatMoney(p.budgetCents) : t('Non renseigné')], [t('Heures prévues'), p.plannedMinutes ? formatMinutes(p.plannedMinutes) : t('Non renseigné')]] : []),
      ],
    );
    add(
      'Situation financière',
      ['Indicateur', 'Montant'],
      [
        [t('Facturé hors TVA · avoirs déduits'), s.invoicedNetLabel],
        [t('Facturé TTC'), s.invoicedTotalLabel],
        [
          t('Paiements reçus'),
          formatSalesTotals(
            salesTotalsByCurrency(invoices, w.payments),
            'paidCents',
          ),
        ],
        [
          t('Reste à recevoir'),
          formatSalesTotals(
            salesTotalsByCurrency(invoices, w.payments),
            'openCents',
          ),
        ],
        ...(!forClient ? [[t('Main-d’œuvre'), formatMoney(s.laborCost)],
        [t('Coût des achats après avoirs'), formatMoney(s.expenseNet)],
        [t('Dont TVA non déductible'), formatMoney(s.nonDeductibleVatCost)],
        [
          t('Marge de gestion'),
          s.marginUnavailableReason ? t(s.marginUnavailableReason) : s.hasActivity ? formatMoney(s.margin) : '—',
        ],
        [
          t('Méthode'),
          t('Marge sur les coûts enregistrés, sans estimation des coûts manquants. Factures émises et avoirs, achats validés et dépenses enregistrées. Devis et brouillons exclus. Devises séparées, sans conversion implicite.'),
        ],
        ] : [[t('Périmètre'),t('Factures émises et avoirs. Montants séparés par devise, sans conversion implicite.')]]),
      ],
    );
  }
  if (included.includes('sales')) {
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
        `${i.issueDate}\n${status(i.status)}\n${t('Échéance')} ${i.dueDate}`,
        `${formatMoney(documentTotals(i.lines).totalCents, i.currency)}\n${t('Reste')} ${i.type === 'credit_note' || ['draft', 'cancelled'].includes(i.status) ? '—' : formatMoney(invoiceOpenBalance(i, w.invoices, w.payments), i.currency)}`,
      ]),
    );
    for (const doc of [...quotes, ...invoices])
      add(
        t('Détail {document}',{document:doc.number || doc.title || t('Brouillon')}),
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
  if (included.includes('purchases')) {
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
  if (included.includes('time'))
    add(
      'Heures et équipe',
      ['Collaborateur / travail', 'Date', 'Durée / coût'],
      w.timeEntries
        .filter((e) => e.projectId === p.id)
        .map((e) => {
          const person = w.employees.find((p) => p.id === e.employeeId);
          return [
            (person?.name || t('Collaborateur')) + '\n' + e.note,
            `${e.date}\n${status(e.status)}`,
            `${formatMinutes(e.minutes)}\n${formatMoney(Math.round((e.minutes * e.hourlyCostCents) / 60))}`,
          ];
        }),
    );
  if (included.includes('planning')) {
    add(
      'Étapes et tâches',
      ['Objet', 'Échéance', 'État'],
      [...w.projectMilestones, ...(forClient ? [] : w.projectTasks)]
        .filter((t) => t.projectId === p.id)
        .map((t) => [
          `${t.title}${forClient ? '' : '\n' + t.description}`,
          t.dueDate,
          status(t.status),
        ]),
    );
    if (!forClient) add(
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
  if (included.includes('documents')) {
    add(
      'Documents du projet',
      ['Fichier', 'Type', 'Ajouté le'],
      (w.attachments ?? [])
        .filter((a) => a.projectId === p.id)
        .map((a) => [a.originalName, a.mimeType, a.createdAt.slice(0, 10)]),
    );
    add('Notes du projet', ['Notes'], [[p.notes || t('Aucune note')]]);
  }
  return {
    title: p.name,
    subtitle: `${t(reportPresets[options.preset ?? 'internal'].label)} · ${t('Toute la durée du projet')}\n${t('Situation enregistrée au {date}', {date:(options.createdAt ?? new Date()).toLocaleDateString(getAppLocale())})}${options.author?.trim() ? '\n' + t('Préparé par {name}', {name:options.author.trim()}) : ''}`,
    sections,
  };
}
