import { BarChart3, ClipboardCheck } from 'lucide-react';
import type { Workspace } from './types';
import { projectTerminology } from './terminology';
import { formatMinutes, formatMoney, projectFinancials } from './utils';
import { Button, EmptyState, StatusBadge } from './ui';

export function ReportsScreen({ workspace, onOpenAccounting }: { workspace: Workspace; onOpenAccounting: () => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const rows = workspace.projects.map((project) => ({
    project,
    stats: projectFinancials(project, workspace.invoices, workspace.payments, workspace.timeEntries, workspace.expenses, workspace.supplierInvoices, workspace.supplierCreditNotes),
  })).filter(({ stats }) => stats.hasActivity);
  if (!workspace.projects.length) return <EmptyState icon={<BarChart3 />} title="Aucun rapport disponible" text={`Les rapports apparaissent après la création d’un ${terminology.singular}. Aucun graphique fictif n’est affiché.`} />;
  return <div className="stack-layout project-reports">
    <div className="report-callout"><BarChart3 size={24} /><div><strong>La marge de chaque projet</strong><p>Facturé net − main-d’œuvre − achats après avoirs. La TVA non déductible reste dans les coûts.</p><small>Dépenses à payer incluses · Brouillons fournisseurs exclus</small></div></div>
    {rows.length ? <div className="report-grid">{rows.map(({ project, stats }) => <article className="report-card" key={project.id}>
      <header><div><h3>{project.name}</h3><p>{formatMinutes(stats.minutes)} saisis</p></div><StatusBadge status={project.status} /></header>
      <div className="report-card__figures">
        <div><span>Facturé net</span><strong>{stats.invoicedNetLabel}</strong></div>
        <div><span>Main-d’œuvre</span><strong>{formatMoney(stats.laborCost)}</strong></div>
        <div><span>Coût des achats{stats.purchaseCostReviewCount ? ' · à contrôler' : ''}</span><strong>{formatMoney(stats.expenseNet)}</strong></div>
      </div>
      <details className="project-purchase-details">
        <summary>Détail des achats</summary>
        <dl>
          <div><dt>Achats avant avoirs</dt><dd>{formatMoney(stats.purchaseGrossCost)}</dd></div>
          <div><dt>Avoirs fournisseurs déduits</dt><dd>− {formatMoney(stats.purchaseCreditCost)}</dd></div>
          <div><dt>Dont TVA non déductible</dt><dd>{formatMoney(stats.nonDeductibleVatCost)}</dd></div>
        </dl>
        <p>Un avoir validé réduit le coût une seule fois. Sa compensation avec une facture n’ajoute pas une deuxième réduction.</p>
      </details>
      {stats.purchaseCostReviewCount ? <div className="project-cost-review" role="status"><ClipboardCheck size={18} /><div><strong>{stats.purchaseCostReviewCount} achat{stats.purchaseCostReviewCount > 1 ? 's' : ''} à contrôler</strong><p>Vérifiez la classification TVA et les écritures de ces achats dans Comptabilité. La marge sera affichée après leur contrôle.</p><Button variant="secondary" size="small" onClick={onOpenAccounting}>Contrôler les achats</Button></div></div> : null}
      <footer><span>Marge de gestion</span><strong className={stats.margin !== null && stats.margin < 0 ? 'is-negative' : ''}>{stats.marginUnavailableReason || formatMoney(stats.margin)}</strong></footer>
    </article>)}</div> : <EmptyState title="Pas encore assez de données" text="Ajoutez une facture émise, des heures avec coût ou un achat pour calculer la rentabilité. Aucun pourcentage n’est inventé." />}
  </div>;
}
