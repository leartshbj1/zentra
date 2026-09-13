import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { payrollSettingsDraft, payrollSettingsIssue } from './payrollSettingsDraft';
import { initialOnboardingSettings } from './onboardingDraft';
import { translations } from './translations';
import { payrollSettingsTranslations } from './translationsPayrollSettings';
import { appLanguages, setAppLanguage, t } from './language';
import { assessSwissPayrollInsuranceReadiness } from './swissPayrollInsuranceReadiness';
import { payrollText, renderPayrollText, type PayrollPresentationRegistry } from './payrollPresentation';
import type { PayrollContributionDefinition } from './types';

it('covers all settings and insurance explanations without changing message parameters', () => {
  const keys = new Set<string>();
  for (const file of ['PayrollSettingsForm.tsx', 'payrollSettingsDraft.ts', 'SwissPayrollRulesPanel.tsx', 'swissPayrollInsuranceReadiness.ts']) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isStringLiteral(node) && /[\sÀ-ÿ]/.test(node.text) && /[A-Za-zÀ-ÿ]/.test(node.text) && !(ts.isJsxAttribute(node.parent) && node.parent.name.getText() === 'className')) keys.add(node.text.trim());
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  expect(keys.size).toBeGreaterThan(140);
  expect([...keys].filter(key => !translations[key])).toEqual([]);
  for (const [key, entries] of Object.entries(payrollSettingsTranslations)) for (const entry of entries) {
    expect([...entry.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), key).toEqual([...key.matchAll(/\{\w+\}/g)].map(m => m[0]).sort());
  }
});

function form() {
  const result = new FormData();
  Object.entries({ enabled: 'on', fiduciaryValidated: 'on', avsFund: 'Caisse AVS {v0}', accidentInsurer: 'Police LAA', pensionFund: 'Pension {v1}', dailyAllowanceInsurer: '', familyAllowanceFund: 'CAF', payrollCanton: 'vd', lppPlanContractNumber: 'LPP-{name}', lppPlanRegulationReference: 'Règlement {v0}', lppPlanEffectiveFrom: '2026-01-01', lppPlanEffectiveTo: '2026-12-31', lppPlanEmployerShareConfirmed: 'on', aanpEmployerCoverageEnabled: 'on', aanpEmployerCoverageReference: 'Accord {v0}', aanpEmployerCoverageEffectiveFrom: '2026-01-01', aanpEmployerCoverageEffectiveTo: '', laaSmallSalaryAssessmentYear: '2026', laaSmallSalaryEvidenceReference: 'Preuve {v2}', laaSmallSalaryAllEmployeesConfirmed: 'on' }).forEach(([key, value]) => result.set(key, value));
  return result;
}
const flags = { pension: true, smallSalary: true };

it('guides invalid pension dates, missing provider, coverage agreements and annual evidence to their own fields', () => {
  for (const [name, value, field] of [
    ['pensionFund', '', 'pensionFund'], ['lppPlanContractNumber', ' ', 'lppPlanContractNumber'],
    ['lppPlanEffectiveFrom', '2026-02-30', 'lppPlanEffectiveFrom'], ['lppPlanEffectiveTo', '2025-12-31', 'lppPlanEffectiveTo'],
    ['lppPlanEmployerShareConfirmed', '', 'lppPlanEmployerShareConfirmed'], ['aanpEmployerCoverageReference', '', 'aanpEmployerCoverageReference'],
    ['aanpEmployerCoverageEffectiveFrom', '2026-02-30', 'aanpEmployerCoverageEffectiveFrom'], ['aanpEmployerCoverageEffectiveTo', '2025-12-31', 'aanpEmployerCoverageEffectiveTo'],
    ['laaSmallSalaryAssessmentYear', '2e3', 'laaSmallSalaryAssessmentYear'], ['laaSmallSalaryEvidenceReference', '', 'laaSmallSalaryEvidenceReference'], ['laaSmallSalaryAllEmployeesConfirmed', '', 'laaSmallSalaryAllEmployeesConfirmed'],
  ]) {
    const data = form(); data.set(name, value);
    const issue = payrollSettingsIssue(payrollSettingsDraft(initialOnboardingSettings.payroll, data, flags));
    expect(issue?.field, name).toBe(field);
    for (const language of appLanguages) {
      const translated = issue?.presentation ? t(issue.presentation.source, issue.presentation.values, language) : t(issue!.message, undefined, language);
      expect(translated.length).toBeGreaterThan(20);
      if (language !== 'fr') expect(translated).not.toBe(issue!.message);
    }
  }
});

it('preserves saved rates, references and flags in every language', () => {
  const current = structuredClone(initialOnboardingSettings.payroll), data = form();
  const expected = payrollSettingsDraft(current, data, flags);
  expect(payrollSettingsIssue(expected)).toBeNull();
  expect(expected.payrollCanton).toBe('VD');
  expect(expected.lppPlanEvidence?.regulationReference).toBe('Règlement {v0}');
  expect(expected.employeeRates).toEqual(current.employeeRates);
  try { for (const language of appLanguages) { setAppLanguage(language); expect(payrollSettingsDraft(current, data, flags)).toEqual(expected); } }
  finally { setAppLanguage('fr'); }
  const disabled = payrollSettingsDraft(current, new FormData(), { pension: false, smallSalary: false });
  expect(disabled.lppPlanEvidence).toBeUndefined(); expect(disabled.laaSmallSalaryException?.enabled).toBe(false);
});

it('translates insurance diagnostics while retaining literal user codes and readiness results', () => {
  const definition = { id: 'qa', code: 'PERSONNEL-{v0}-{v1}', label: 'Libellé privé', category: 'aap', side: 'employee', active: true, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', calculationKind: 'rate', rateBp: 0, annualCeilingCents: null, basisKind: 'gross', source: '' } as PayrollContributionDefinition;
  const input = { settings: initialOnboardingSettings, definitions: [definition], employees: [{ active: true, contractualWeeklyMinutes: 2400 }], asOf: '2026-09-30' };
  const raw = assessSwissPayrollInsuranceReadiness(input), presentations: PayrollPresentationRegistry = new Map();
  expect(assessSwissPayrollInsuranceReadiness(input, presentations)).toEqual(raw);
  expect(raw.aap.issues.length).toBeGreaterThan(4);
  for (const language of appLanguages) for (const section of Object.values(raw)) for (const message of section.issues) {
    const shown = renderPayrollText(payrollText(presentations, message), `${language}-CH`, (source, values) => t(source, values, language));
    if (language === 'fr') expect(shown).toBe(message); else expect(shown).not.toBe(message);
    if (message.includes(definition.code)) expect(shown).toContain(definition.code);
  }
});
