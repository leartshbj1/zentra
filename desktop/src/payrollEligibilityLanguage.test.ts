import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { appLanguages, setAppLanguage, t } from './language';
import { translations } from './translations';
import { payrollEligibilityTranslations } from './translationsPayrollEligibility';
import { assessPayrollForDisplay, payrollEligibilityText } from './payrollEligibilityLanguage';
import { payrollMessage, renderPayrollText, type PayrollPresentationRegistry } from './payrollPresentation';
import { assessSwissPayrollEligibility } from './payrollEligibility';
import { initialOnboardingSettings } from './onboardingDraft';
import type { Employee, PayrollContributionDefinition } from './types';

it('covers every eligibility explanation, status and fact, with the same message parameters', () => {
  const ast = ts.createSourceFile('payrollEligibility.ts', readFileSync(new URL('./payrollEligibility.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const keys = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) && /[\sàâçéèêëîïôùûüœ]/i.test(node.text) && node.text.trim()) keys.add(node.text);
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'source' && ts.isStringLiteral(node.initializer)) keys.add(node.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(keys.size).toBeGreaterThan(130);
  expect([...keys].filter(key => !translations[key])).toEqual([]);
  for (const [key, entries] of Object.entries(payrollEligibilityTranslations)) for (const entry of entries) {
    expect(entry.trim()).not.toBe('');
    expect([...entry.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), key).toEqual([...key.matchAll(/\{\w+\}/g)].map(m => m[0]).sort());
  }
});

it('formats money and hours for each language without interpolating user references a second time', () => {
  const registry: PayrollPresentationRegistry = new Map();
  const reference = 'Contrat {v0} {v2} — À confirmer';
  const original = payrollMessage(registry, 'La date réglementaire {v0} sort de la fenêtre du règlement LPP {v1} ({v2} à {v3}).', { v0: '2026-09-30', v1: reference, v2: '2026-01-01', v3: '2026-08-31' });
  const money = payrollMessage(registry, 'Seuil annuel de {v0} dépassé', { v0: { kind: 'money', cents: 250000 } });
  const hours = payrollMessage(registry, '{v0} h/semaine', { v0: { kind: 'number', value: 7.983333333, maximumFractionDigits: 2 } });
  const nested = payrollMessage(registry, '{v0} · {v1} · {v2}', { v0: { source: 'Secteur ordinaire' }, v1: registry.get(money)!, v2: reference });
  for (const language of appLanguages) {
    const render = (raw: string) => renderPayrollText(registry.get(raw)!, `${language}-CH`, (source, values) => t(source, values, language));
    expect(render(original)).toContain(reference);
    expect(render(money)).toContain((2500).toLocaleString(`${language}-CH`, { style: 'currency', currency: 'CHF' }));
    expect(render(hours)).toContain((7.983333333).toLocaleString(`${language}-CH`, { maximumFractionDigits: 2 }));
    expect(render(nested)).toContain(render(money));
    expect(render(nested)).toContain(reference);
    if (language === 'fr') expect(render(original)).toBe(original);
    else expect(render(original)).not.toBe(original);
  }
});

it('retains assessment results and routing diagnostics while switching display languages', () => {
  const employee = {
    id: 'qa-employee', birthDate: '1990-01-01', employmentStart: '2026-01-01', employmentEnd: '', employmentContractKind: 'indefinite',
    contractualWeeklyMinutes: 2395, lppAssessmentYear: 2026, lppAnnualSalaryCents: 6000000, lppExceptionCode: null, lppExceptionEvidenceReference: '',
    avsAllowanceWaived: null, smallSalaryAssessmentYear: 2026, smallSalarySector: 'ordinary', smallSalaryEmployeeRequestedContributions: false,
    smallSalaryDecisionDate: '2026-01-01', smallSalaryOpeningGrossCents: 123456, smallSalaryOpeningContributedBasisCents: 12345, smallSalaryEvidenceReference: 'Justificatif {v0}',
    acOpeningYear: 2026, acOpeningBasisCents: 23456,
  } as Employee;
  const pension = { id: 'qa-lpp', code: 'USER-{v0}', label: 'Contrat personnel {v2}', category: 'lpp', side: 'employee', calculationKind: 'fixed', fixedAmountCents: 25000, basisKind: 'coordinated', lppComponent: 'combined', lppEmployeeId: employee.id, active: true, source: 'Règlement de test', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' } as PayrollContributionDefinition;
  const settings = { ...initialOnboardingSettings, payroll: { ...initialOnboardingSettings.payroll, pensionFund: 'Caisse {v0}', lppPlanEvidence: { contractNumber: 'Contrat {v0} {v2}', regulationReference: 'Règlement de test', effectiveFrom: '2026-01-01', effectiveTo: '2026-08-31', employerAggregateShareConfirmed: true } } };
  const input = { employee, settings, period: '2026-09', contributionDate: '2026-09-30', grossCents: 512345, definitions: [pension], selectedIds: new Set([pension.id]) };
  const original = assessSwissPayrollEligibility(input);
  const view = assessPayrollForDisplay(input);
  expect(view.blockers.some(message => message.includes('Contrat {v0} {v2}'))).toBe(true);
  expect(view.facts).toHaveLength(13);
  const { presentations: _presentations, ...raw } = view;
  expect(raw).toEqual(original);
  const before = JSON.stringify(input);
  try {
    for (const language of appLanguages) {
      setAppLanguage(language);
      expect(assessSwissPayrollEligibility(input)).toEqual(original);
      for (const message of [...view.blockers, ...view.warnings]) {
        const rendered = payrollEligibilityText(view, message);
        if (language === 'fr') expect(rendered).toBe(message);
        else expect(rendered).not.toBe(message);
        if (message.includes('Contrat {v0} {v2}')) expect(rendered).toContain('Contrat {v0} {v2}');
      }
      const money = view.facts.find(fact => fact.label === 'Salaire annuel LPP confirmé')!;
      expect(payrollEligibilityText(view, money.value)).toBe((60000).toLocaleString(`${language}-CH`, { style: 'currency', currency: 'CHF' }));
    }
  } finally { setAppLanguage('fr'); }
  expect(JSON.stringify(input)).toBe(before);
});
