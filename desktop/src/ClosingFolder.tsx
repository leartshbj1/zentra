import { AlertTriangle, CheckCircle2, CircleDashed, FileCheck2, LockKeyhole, Scale } from 'lucide-react';
import type { AccountingPeriod, PeriodFilter, TrialBalanceReport } from './types';
import { buildClosingChecks, closingReadiness, type ComparativeBalanceSheet, type ComparativeIncomeStatement } from './accountingClosure';
import { formatDate, formatMoney } from './utils';
import { EmptyState, SectionHeading } from './ui';
import './ClosingFolder.css';

export function ClosingFolder({
  filter,
  period,
  trial,
  balance,
  income,
}: {
  filter: PeriodFilter;
  period?: AccountingPeriod;
  trial: TrialBalanceReport | null;
  balance: ComparativeBalanceSheet | null;
  income: ComparativeIncomeStatement | null;
}) {
  const checks = buildClosingChecks({ filter, period, trial, balance, income });
  const readiness = closingReadiness(checks);
  const scope = balance?.scope ?? income?.scope;

  if (!filter.dateFrom || !filter.dateTo) {
    return <section className="panel closing-folder"><EmptyState icon={<FileCheck2 />} title="Choisissez un exercice" text="Le dossier de clôture exige une date de début et une date de fin explicites. Sélectionnez un exercice enregistré ou complétez les deux dates dans la barre supérieure." /></section>;
  }

  return <section className="panel closing-folder">
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

    <div className="closing-limitation">
      <LockKeyhole size={18} />
      <p><strong>Périmètre honnête.</strong> Ce dossier assiste la clôture technique locale. Il ne génère pas l’annexe légale, les décisions d’approbation, une déclaration fiscale, un rapport de révision ou une signature; ces pièces doivent être établies et validées séparément par les responsables compétents.</p>
    </div>
  </section>;
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
