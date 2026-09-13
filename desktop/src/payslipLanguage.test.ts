import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { translations } from './translations';
import { payslipTranslations } from './translationsPayslip';
import { t, appLanguages, setAppLanguage } from './language';
import { PAYROLL_BASIS_LABELS, PAYROLL_STEPS, recurringSalary } from './payrollGuidance';
import { SWISS_FAMILY_ALLOWANCES_2026 } from './swissFamilyAllowances2026';
import { smallSalaryReasonLabel, smallSalarySectorLabel } from './smallSalaryAssessment';
import { payrollCalculationFingerprint } from './payrollCalculationFingerprint';
import type { Employee } from './types';

it('covers the main payslip wizard, its monthly guidance and dynamic message parameters', () => {
  const keys = new Set<string>();
  function literals(node: ts.Node) {
    if(ts.isStringLiteral(node)) keys.add(node.text.trim());
    else if(ts.isConditionalExpression(node)) { literals(node.whenTrue); literals(node.whenFalse); }
    else if(ts.isArrayLiteralExpression(node)) node.elements.forEach(literals);
    else if(ts.isElementAccessExpression(node)) literals(node.expression);
  }
  for(const file of ['DetailedPayslipForm.tsx','PayrollMonthOverview.tsx']) {
    const ast=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if(ts.isCallExpression(node)&&node.expression.getText()==='t'&&node.arguments[0])literals(node.arguments[0]);
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  [...PAYROLL_STEPS,...Object.values(PAYROLL_BASIS_LABELS)].forEach(key=>keys.add(key));
  expect(keys.size).toBeGreaterThan(175);
  expect([...keys].filter(key=>!translations[key])).toEqual([]);
  for(const key of new Set([...keys,...Object.keys(payslipTranslations)])) for(const value of translations[key]) {
    const placeholders=(text:string)=>[...text.matchAll(/\{\w+\}/g)].map(match=>match[0]).sort();
    expect(placeholders(value),key).toEqual(placeholders(key));
  }
});

it('translates all canton names and explanatory notes while preserving their codes and published amounts', () => {
  const before=JSON.stringify(SWISS_FAMILY_ALLOWANCES_2026);
  expect(SWISS_FAMILY_ALLOWANCES_2026).toHaveLength(26);
  for(const language of appLanguages)for(const reference of SWISS_FAMILY_ALLOWANCES_2026) {
    expect(translations[reference.name]).toHaveLength(3);
    if(reference.note)expect(translations[reference.note]).toHaveLength(3);
    expect(t(reference.name,undefined,language)).not.toBe('');
  }
  expect(JSON.stringify(SWISS_FAMILY_ALLOWANCES_2026)).toBe(before);
  expect(t('Net à payer à {name}',{name:'Élodie {name} Déclaration'},'de')).toBe('Nettolohn für Élodie {name} Déclaration');
});

it('keeps persisted salary labels and the calculation fingerprint unchanged across interface languages', () => {
  const employee={id:'employee-qa',salaryMode:'monthly',grossSalaryCents:512345} as Employee;
  const storedLines=recurringSalary(employee);
  expect(storedLines).toMatchObject([{label:'Salaire mensuel',amountCents:512345}]);
  const lines=storedLines.map(line=>({...line,id:'line-qa',kind:'earning' as const}));
  const input={employeeId:employee.id,period:'2026-09',paymentDate:'2026-09-30',lines,selections:[{definitionId:'policy-{name}',basisCents:512345}]};
  const fingerprint=payrollCalculationFingerprint(input);
  try {
    for(const language of appLanguages) {
      setAppLanguage(language);
      expect(recurringSalary(employee)).toEqual(storedLines);
      expect(payrollCalculationFingerprint(input)).toBe(fingerprint);
      for(const sector of ['ordinary','private_household','arts_culture'] as const)expect(translations[smallSalarySectorLabel(sector)]).toHaveLength(3);
      for(const reason of ['ordinary_minor_salary_exempt','ordinary_employee_request','ordinary_threshold_exceeded','private_household_mandatory','private_household_youth_minor_salary_exempt','private_household_youth_employee_request','private_household_youth_threshold_exceeded','arts_culture_mandatory'])expect(translations[smallSalaryReasonLabel(reason)]).toHaveLength(3);
    }
  } finally {setAppLanguage('fr');}
});
