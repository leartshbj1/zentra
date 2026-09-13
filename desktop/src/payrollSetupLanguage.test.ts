import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { translations } from './translations';
import { payrollSetupTranslations } from './translationsPayrollSetup';
import { appLanguages, setAppLanguage, t } from './language';
import { pensionPlanIssue } from './payrollPension';
import { contractContribution, CONTRACT_PRESETS } from './payrollContractPresets';
import { contributionDraftPayload } from './PayrollContributionsPanel';
import { initialOnboardingSettings } from './onboardingDraft';

it('covers migrated setup controls and every translated message parameter', () => {
  const keys=new Set<string>();
  function literals(node:ts.Node) {
    if(ts.isStringLiteral(node))keys.add(node.text.trim());
    else if(ts.isConditionalExpression(node)){literals(node.whenTrue);literals(node.whenFalse);}
    else if(ts.isArrayLiteralExpression(node))node.elements.forEach(literals);
    else if(ts.isElementAccessExpression(node))literals(node.expression);
    else if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node))literals(node.expression);
    else if(ts.isObjectLiteralExpression(node))node.properties.forEach(property=>{if(ts.isPropertyAssignment(property))literals(property.initializer);});
  }
  for(const file of ['PayrollSetup.tsx','PayrollContractSetup.tsx','PayrollContributionsPanel.tsx']) {
    const ast=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node:ts.Node) {
      if(ts.isCallExpression(node)&&node.expression.getText()==='t'&&node.arguments[0])literals(node.arguments[0]);
      if(ts.isVariableDeclaration(node)&&['sections','categoryLabels','lppComponentLabels'].includes(node.name.getText())&&node.initializer)literals(node.initializer);
      ts.forEachChild(node,visit);
    } visit(ast);
  }
  ['person','history','insurance','contributions'].forEach(key=>keys.delete(key));
  Object.values(CONTRACT_PRESETS).forEach(preset=>{keys.add(preset.label);keys.add(preset.explanation);});
  expect(keys.size).toBeGreaterThan(210);
  expect([...keys].filter(key=>!translations[key])).toEqual([]);
  for(const key of new Set([...keys,...Object.keys(payrollSetupTranslations)])) for(const translated of translations[key]) {
    expect([...translated.matchAll(/\{\w+\}/g)].map(match=>match[0]).sort(),key).toEqual([...key.matchAll(/\{\w+\}/g)].map(match=>match[0]).sort());
  }
});

it('keeps pension routing and dates while translating the three period errors', () => {
  const payroll={...initialOnboardingSettings.payroll,pensionFund:'Caisse {name}',lppPlanEvidence:{contractNumber:'C-2026',regulationReference:'Règlement QA 2026',effectiveFrom:'2026-01-01',effectiveTo:'2026-08-31',employerAggregateShareConfirmed:true}};
  const cases=[pensionPlanIssue(payroll,'2026-09-30'),pensionPlanIssue(payroll,'2025-12-31'),pensionPlanIssue({...payroll,lppPlanEvidence:{...payroll.lppPlanEvidence,effectiveTo:'2025-12-31'}})];
  expect(cases.map(issue=>issue?.field)).toEqual(['lppTo','lppFrom','lppTo']);
  for(const issue of cases) {
    expect(issue?.presentation).toBeDefined();
    expect(t(issue!.presentation!.source,issue!.presentation!.values,'fr')).toBe(issue!.message);
    for(const language of appLanguages) {
      const result=t(issue!.presentation!.source,issue!.presentation!.values,language);
      for(const value of Object.values(issue!.presentation!.values!))expect(result).toContain(String(value));
      if(language!=='fr')expect(result).not.toBe(issue!.message);
    }
  }
  const raw=pensionPlanIssue({...payroll,pensionFund:''})!;expect(translations[raw.message]).toHaveLength(3);
});

it('never translates saved contribution labels, references, identifiers or amounts', () => {
  const input={id:'qa-policy',category:'aanp' as const,side:'employee' as const,rate:'1.25',amountCents:0,employeeId:'elodie',component:null,source:'Police {name} 2026',from:'2026-01-01',to:'2026-12-31',liability:'liability-qa',expense:''};
  const original=contractContribution(input);
  const form=new FormData();Object.entries({code:'USER-CODE',label:'Police {title} — privée',side:'employee',rate:'1.25',basisKind:'ahv_salary',source:'Contrat {year}',effectiveFrom:'2026-01-01',effectiveTo:'2026-12-31',active:'yes',liabilityAccountId:'account-qa'}).forEach(([key,value])=>form.set(key,value));
  const options={id:'custom-qa',category:'aanp' as const,calculationKind:'rate' as const},saved=contributionDraftPayload(form,options);
  try {for(const language of appLanguages){setAppLanguage(language);expect(contractContribution(input)).toEqual(original);expect(contributionDraftPayload(form,options)).toEqual(saved);expect(saved.rateBp).toBe(125);expect(saved.label).toBe('Police {title} — privée');}}finally{setAppLanguage('fr');}
});
