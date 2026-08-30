import { useEffect, useMemo, useState } from 'react';
import { Archive, CheckCircle2, Plus, ShieldCheck } from 'lucide-react';
import { desktopApi } from './bridge';
import type { PayrollCalculation, PayrollContributionDefinition, PayrollContributionSelection, Payslip, PayslipLine, Workspace } from './types';
import { createId, formatMoney, payslipTotals } from './utils';
import { Button, ErrorPanel, Field, FormActions, Modal, submitForm } from './ui';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;
type SelectionDraft = { basisCents?: number; yearToDateBasisCents?: number };

export function DetailedPayslipForm({ item, workspace, busy, close, act }: { item?: Payslip; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const [lines, setLines] = useState<PayslipLine[]>(item?.lines.map((line) => ({ ...line })) ?? []);
  const [definitions, setDefinitions] = useState<PayrollContributionDefinition[]>([]);
  const [selections, setSelections] = useState<Record<string, SelectionDraft>>({});
  const [calculation, setCalculation] = useState<PayrollCalculation | null>(null);
  const [period, setPeriod] = useState(item?.period ?? '');
  const [loadingRates, setLoadingRates] = useState(true);
  const [existingBlocked, setExistingBlocked] = useState(false);
  const [localError, setLocalError] = useState('');
  const totals = payslipTotals({ id: item?.id ?? '', employeeId: item?.employeeId ?? '', period, status: item?.status ?? 'incomplete', lines, notes: item?.notes ?? '', createdAt: item?.createdAt ?? '' });

  useEffect(() => {
    let active = true;
    setLoadingRates(true);
    void Promise.all([
      desktopApi.listPayrollContributionDefinitions(period || undefined),
      item ? desktopApi.getPayslipContributions(item.id) : Promise.resolve([]),
    ]).then(([items, snapshots]) => {
      if (!active) return;
      const available = items.filter((definition) => definition.active);
      const linkedItems = new Set(snapshots.map((snapshot) => snapshot.payslipItemId));
      const missing = snapshots.filter((snapshot) => !available.some((definition) => definition.id === snapshot.definitionId));
      setDefinitions(available);
      if (item) setLines(item.lines.filter((line) => !linkedItems.has(line.id)).map((line) => ({ ...line })));
      setSelections(Object.fromEntries(snapshots.map((snapshot) => [snapshot.definitionId, {
        basisCents: snapshot.basisCents,
        yearToDateBasisCents: snapshot.yearToDateBasisCents ?? undefined,
      }])));
      setExistingBlocked(missing.length > 0);
      setCalculation(null);
      if (missing.length) setLocalError(`Réactivez les définitions suivantes avant de modifier cette fiche : ${missing.map((snapshot) => snapshot.label).join(', ')}.`);
    }).catch((reason) => {
      if (!active) return;
      setExistingBlocked(Boolean(item));
      setLocalError(reason instanceof Error ? reason.message : 'Les cotisations de la fiche n’ont pas pu être chargées.');
    }).finally(() => { if (active) setLoadingRates(false); });
    return () => { active = false; };
  }, [item, period]);

  const selectedItems = useMemo<PayrollContributionSelection[]>(() => Object.entries(selections).map(([definitionId, values]) => ({ definitionId, ...values })), [selections]);

  function addLine(kind: PayslipLine['kind']) { setLines((current) => [...current, { id: createId(), label: '', kind, amountCents: 0 }]); setCalculation(null); }
  function updateLine(id: string, patch: Partial<PayslipLine>) { setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line)); setCalculation(null); }

  function toggleDefinition(definition: PayrollContributionDefinition, checked: boolean) {
    setCalculation(null);
    setSelections((current) => {
      if (!checked) { const next = { ...current }; delete next[definition.id]; return next; }
      return { ...current, [definition.id]: { basisCents: definition.basisKind === 'gross' ? totals.earnings : undefined, yearToDateBasisCents: undefined } };
    });
  }

  function patchSelection(id: string, patch: SelectionDraft) { setCalculation(null); setSelections((current) => ({ ...current, [id]: { ...current[id], ...patch } })); }

  async function calculate() {
    setLocalError('');
    if (existingBlocked) { setLocalError('Réactivez les définitions historiques indiquées avant de recalculer cette fiche.'); return; }
    if (!period || totals.earnings <= 0) { setLocalError('Saisissez la période et au moins un gain positif avant le calcul.'); return; }
    for (const definition of definitions.filter((candidate) => selections[candidate.id])) {
      const selected = selections[definition.id];
      if ((definition.basisKind !== 'gross' && selected.basisCents === undefined) || (definition.annualCeilingCents && selected.yearToDateBasisCents === undefined)) { setLocalError(`Complétez la base${definition.annualCeilingCents ? ' et le cumul annuel' : ''} pour ${definition.label}.`); return; }
    }
    try { setCalculation(await desktopApi.calculatePayrollContributions({ period, grossCents: totals.earnings, items: selectedItems })); }
    catch (reason) { setLocalError(reason instanceof Error ? reason.message : 'Le calcul local des cotisations a échoué.'); }
  }

  return <Modal title={item ? 'Modifier la fiche détaillée' : 'Nouvelle fiche de salaire'} description="Gains, bases, taux, plafonds et parts sont visibles. Aucune retenue n’est estimée." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    setLocalError('');
    if (loadingRates || existingBlocked) { setLocalError('Le détail des cotisations doit être disponible avant l’enregistrement.'); return; }
    if (!lines.length || lines.some((line) => !line.label.trim() || line.amountCents < 0)) { setLocalError('Ajoutez des lignes valides avec un libellé et un montant.'); return; }
    if (selectedItems.length && !calculation) { setLocalError('Calculez et contrôlez les cotisations sélectionnées avant d’enregistrer.'); return; }
    const status: Payslip['status'] = workspace.settings?.payroll.fiduciaryValidated && form.get('validated') === 'on' ? 'validated' : 'incomplete';
    const data = { employeeId: String(form.get('employeeId')), period, status, grossCents: totals.earnings, deductionsCents: totals.deductions, netCents: totals.net, employerCostsCents: totals.employer, paymentDate: '', notes: String(form.get('notes')) };
    await act(() => desktopApi.savePayslipWithContributions(data, lines, item, period, selectedItems), item ? 'La fiche et ses cotisations ont été mises à jour.' : 'La fiche et ses cotisations explicites ont été enregistrées.');
  })}><div className="form-grid"><Field label="Collaborateur" required><select name="employeeId" defaultValue={item?.employeeId} required><option value="">Choisir un collaborateur</option>{workspace.employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></Field><Field label="Période" required><input name="period" type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setCalculation(null); }} required /></Field></div>{localError ? <ErrorPanel message={localError} /> : null}<section className="pay-lines"><header><div><strong>Éléments de salaire</strong><small>Salaire, heures, indemnités, allocations et avantages sont saisis séparément.</small></div><div><Button type="button" variant="secondary" size="small" onClick={() => addLine('earning')}><Plus size={14} /> Gain</Button><Button type="button" variant="secondary" size="small" onClick={() => addLine('deduction')}><Plus size={14} /> Retenue hors moteur</Button><Button type="button" variant="secondary" size="small" onClick={() => addLine('employer')}><Plus size={14} /> Charge hors moteur</Button></div></header>{lines.length ? <div className="pay-line-list">{lines.map((line) => <div key={line.id}><select value={line.kind} onChange={(event) => updateLine(line.id, { kind: event.target.value as PayslipLine['kind'] })}><option value="earning">Gain</option><option value="deduction">Retenue hors moteur</option><option value="employer">Charge employeur hors moteur</option></select><input value={line.label} onChange={(event) => updateLine(line.id, { label: event.target.value })} placeholder="Libellé réel" required /><label className="money-input"><input type="number" min="0" step="0.01" value={line.amountCents ? line.amountCents / 100 : ''} onChange={(event) => updateLine(line.id, { amountCents: Math.round((event.target.valueAsNumber || 0) * 100) })} required /><span>CHF</span></label><Button type="button" variant="ghost" size="icon" onClick={() => { setLines((current) => current.filter((candidate) => candidate.id !== line.id)); setCalculation(null); }}><Archive size={15} /></Button></div>)}</div> : <div className="rate-empty">Ajoutez les gains et montants confirmés pour cette période.</div>}</section><section className="payroll-selection"><header><div><strong>Cotisations à appliquer</strong><small>Choisissez les définitions réellement applicables à ce collaborateur.</small></div><Button type="button" variant="secondary" disabled={loadingRates || existingBlocked || !selectedItems.length} onClick={() => void calculate()}>Calculer les cotisations</Button></header>{definitions.length ? <div className="contribution-selection-list">{definitions.map((definition) => { const selected = selections[definition.id]; return <article key={definition.id} className={selected ? 'is-selected' : ''}><label><input type="checkbox" checked={Boolean(selected)} onChange={(event) => toggleDefinition(definition, event.target.checked)} /><span><strong>{definition.code} · {definition.label}</strong><small>Part {definition.side === 'employee' ? 'employé' : 'employeur'} · {definition.calculationKind === 'rate' ? `${((definition.rateBp ?? 0) / 100).toLocaleString('fr-CH')} %` : formatMoney(definition.fixedAmountCents)} · base {definition.basisKind}</small><small>{definition.source}</small></span></label>{selected ? <div className="selection-bases"><Field label="Base de calcul (CHF)" required><input type="number" min="0" step="0.01" value={selected.basisCents === undefined ? '' : selected.basisCents / 100} onChange={(event) => patchSelection(definition.id, { basisCents: Math.round((event.target.valueAsNumber || 0) * 100) })} required /></Field>{definition.annualCeilingCents ? <Field label="Base cumulée avant ce mois (CHF)" required hint={`Plafond annuel ${formatMoney(definition.annualCeilingCents)}`}><input type="number" min="0" step="0.01" value={selected.yearToDateBasisCents === undefined ? '' : selected.yearToDateBasisCents / 100} onChange={(event) => patchSelection(definition.id, { yearToDateBasisCents: Math.round((event.target.valueAsNumber || 0) * 100) })} required /></Field> : null}</div> : null}</article>; })}</div> : <div className="warning-card"><ShieldCheck size={18} /><div><strong>Aucune définition active</strong><p>Configurez les cotisations dans Paramètres avant de calculer une fiche.</p></div></div>}</section>{calculation ? <section className="payroll-calculation"><header><CheckCircle2 size={18} /><div><strong>Calcul contrôlable</strong><small>Période {calculation.period} · brut {formatMoney(calculation.grossCents)}</small></div></header><div className="payroll-calculation-lines">{calculation.items.map((result) => <div key={`${result.id}-${result.side}`}><span>{result.label}<small>Base {formatMoney(result.basisCents)} · {result.rateBp !== null ? `${(result.rateBp / 100).toLocaleString('fr-CH')} %` : 'montant fixe'}</small></span><strong>{formatMoney(result.amountCents)}</strong></div>)}</div><footer><span>Retenues employé <strong>{formatMoney(calculation.employeeDeductionsCents)}</strong></span><span>Charges employeur <strong>{formatMoney(calculation.employerCostsCents)}</strong></span></footer></section> : null}<div className="document-bottom"><Field label="Notes"><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field><div className="document-totals"><div><span>Brut saisi</span><strong>{formatMoney(totals.earnings)}</strong></div><div><span>Retenues manuelles</span><strong>{formatMoney(totals.deductions)}</strong></div><div><span>Net avant cotisations calculées</span><strong>{formatMoney(totals.net)}</strong></div></div></div>{workspace.settings?.payroll.fiduciaryValidated ? <label className="check-card"><input name="validated" type="checkbox" defaultChecked={item?.status === 'validated'} /><span><strong>Valider cette fiche</strong><small>Confirmez que les bases, taux et résultats ont été contrôlés.</small></span></label> : <div className="warning-card"><ShieldCheck size={18} /><div><strong>La fiche restera à contrôler</strong><p>La configuration de paie n’est pas marquée comme validée par une fiduciaire.</p></div></div>}<FormActions onCancel={close} busy={busy || loadingRates || existingBlocked} /></form></Modal>;
}
