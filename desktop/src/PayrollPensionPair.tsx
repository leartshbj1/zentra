import { useState } from 'react';
import { desktopApi } from './bridge';
import { Button, Field, submitForm } from './ui';
import { usePayrollFieldGuide } from './PayrollFieldGuide';
import {
  contractContribution,
  singlePayrollAccount,
} from './payrollContractPresets';
import { centsFromInput, createId } from './utils';
import type {
  Account,
  PayrollContributionDefinition,
  Workspace,
} from './types';

export function PayrollPensionPair({
  workspace,
  employeeId,
  existing,
  accounts,
  disabled,
  run,
}: {
  workspace: Workspace;
  employeeId: string;
  existing: PayrollContributionDefinition[];
  accounts: Account[];
  disabled: boolean;
  run: (action: () => Promise<Workspace>) => Promise<void>;
}) {
  const [ids] = useState(() => ({
    employee: existing.find((d) => d.side === 'employee')?.id ?? createId(),
    employer: existing.find((d) => d.side === 'employer')?.id ?? createId(),
  }));
  const fieldGuide = usePayrollFieldGuide();
  const [error, setError] = useState('');
  const plan = workspace.settings!.payroll.lppPlanEvidence!;
  return (
    <form
      className="payroll-pension-pair"
      noValidate
      onSubmit={(event) => {
        if (!fieldGuide.check(event.currentTarget)) {
          event.preventDefault();
          return;
        }
        return submitForm(async (form) => {
          setError('');
          try {
            const desired = (['employee', 'employer'] as const).map((side) => {
              const previous = existing.find((d) => d.side === side);
              const input = contractContribution({
                id: ids[side],
                category: 'lpp',
                side,
                rate: '',
                amountCents: centsFromInput(form.get(side)),
                employeeId,
                component: String(form.get('component')) as
                  | 'combined'
                  | 'risk'
                  | 'savings',
                source: String(form.get('source')),
                from: String(form.get('from')),
                to: String(form.get('to')),
                liability:
                  previous?.liabilityAccountId ??
                  singlePayrollAccount(accounts, 'liability'),
                expense:
                  side === 'employee'
                    ? ''
                    : (previous?.expenseAccountId ??
                      singlePayrollAccount(accounts, 'expense')),
              });
              if (
                input.source.trim() !== plan.regulationReference.trim() ||
                input.effectiveFrom < plan.effectiveFrom ||
                input.effectiveTo > plan.effectiveTo
              )
                throw Error(
                  'Reprenez la référence et la période confirmées par le contrat de pension.',
                );
              return previous
                ? { ...input, code: previous.code, label: previous.label }
                : input;
            });
            await run(async () => {
              const current =
                await desktopApi.listPayrollContributionDefinitions();
              const equal = (
                a: PayrollContributionDefinition,
                b: PayrollContributionDefinition,
              ) =>
                Object.keys(b).every(
                  (key) =>
                    a[key as keyof typeof a] === b[key as keyof typeof b],
                );
              if (
                current.some(
                  (d) =>
                    d.active &&
                    d.category === 'lpp' &&
                    d.lppEmployeeId === employeeId &&
                    desired.some(
                      (item) =>
                        d.effectiveFrom <= item.effectiveTo &&
                        (!d.effectiveTo || d.effectiveTo >= item.effectiveFrom),
                    ) &&
                    !desired.some((item) => item.id === d.id),
                )
              )
                throw Error(
                  'Une autre cotisation de pension a été ajoutée. Rouvrez ce point pour vérifier les couvertures avant de continuer.',
                );
              // Inspect both before writing; a retry keeps the first saved part and never duplicates it.
              for (const item of desired) {
                const fresh = current.find((d) => d.id === item.id);
                const previous = existing.find((d) => d.id === item.id);
                if (
                  fresh &&
                  !equal(fresh, item) &&
                  (!previous || !equal(fresh, previous))
                )
                  throw Error(
                    'Les montants de pension ont changé pendant votre saisie. Rouvrez ce point pour retrouver les dernières informations.',
                  );
                if (previous && !fresh)
                  throw Error(
                    'Cette cotisation de pension n’existe plus. Rouvrez ce point pour actualiser les informations.',
                  );
              }
              for (const item of desired) {
                const fresh = current.find((d) => d.id === item.id);
                if (!fresh || !equal(fresh, item))
                  await desktopApi.upsertPayrollContributionDefinition(item);
              }
              return desktopApi.loadWorkspace();
            });
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : 'Les montants n’ont pas pu être enregistrés. Votre saisie est conservée.',
            );
          }
        })(event);
      }}
    >
      {fieldGuide.guide}
      {error && (
        <p className="payroll-field-guide" role="alert">
          {error}
        </p>
      )}
      <fieldset disabled={disabled}>
        <h4>Recopiez les deux montants mensuels du certificat</h4>
        <p>
          La part du salarié sera retenue sur son salaire. La part de
          l’entreprise s’ajoute à son coût.
        </p>
        <div className="form-grid">
          {(['employee', 'employer'] as const).map((side) => (
            <Field
              key={side}
              label={
                side === 'employee'
                  ? 'Part du salarié par mois (CHF)'
                  : 'Part de l’entreprise par mois (CHF)'
              }
              required
            >
              <input
                name={side}
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                required
                defaultValue={
                  existing.find((d) => d.side === side)?.fixedAmountCents ==
                  null
                    ? ''
                    : existing.find((d) => d.side === side)!.fixedAmountCents! /
                      100
                }
              />
            </Field>
          ))}
        </div>
        <Field label="Que couvrent ces montants sur le certificat ?" required>
          <select
            name="component"
            required
            defaultValue={existing[0]?.lppComponent ?? ''}
          >
            <option value="">Choisir d’après le certificat</option>
            <option value="combined">Épargne et risques réunis</option>
            <option value="risk">Risques uniquement</option>
            <option value="savings">Épargne uniquement</option>
          </select>
        </Field>
        <details className="payroll-simple-guide">
          <summary>Dates et référence reprises du contrat</summary>
          <Field label="Début de validité" required>
            <input
              type="date"
              name="from"
              required
              min="2026-01-01"
              max="2026-12-31"
              defaultValue={existing[0]?.effectiveFrom ?? plan.effectiveFrom}
            />
          </Field>
          <Field label="Fin de la période confirmée" required>
            <input
              type="date"
              name="to"
              required
              min="2026-01-01"
              max="2026-12-31"
              defaultValue={existing[0]?.effectiveTo ?? plan.effectiveTo}
            />
          </Field>
          <Field label="Référence du règlement" required>
            <input
              name="source"
              required
              minLength={8}
              maxLength={500}
              defaultValue={plan.regulationReference}
            />
          </Field>
        </details>
        <label className="check-card">
          <input type="checkbox" required />
          <span>
            J’ai vérifié ces deux montants et leur couverture sur le certificat
            de prévoyance.
          </span>
        </label>
        <Button type="submit" disabled={disabled}>
          Enregistrer les deux montants
        </Button>
      </fieldset>
    </form>
  );
}
