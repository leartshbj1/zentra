import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { appLanguages, setAppLanguage, t } from './language';
import { translations } from './translations';
import { payrollDateValidity, payrollFieldMessage, type PayrollFieldValidation } from './payrollFieldLanguage';
import { groupedPayrollHelp } from './payrollHelp';
import { payrollPreparationTasks } from './payrollPreparationTasks';
import { payrollBasisNames } from './payrollSalaryEntry';

afterEach(() => setAppLanguage('fr'));
const field: PayrollFieldValidation = {
  type: 'text', name: '', value: '', min: '', max: '', select: false, required: true,
  typeMismatch: false, valueMissing: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false,
};
it('validates actual dates and inclusive bounds when the webview falls back to a text input', () => {
  for(const value of ['2026-02-29','2026-04-31','2026-13-01','2026-9-01','not a date'])expect(payrollDateValidity(value,'2026-01-01','2026-12-31').typeMismatch,value).toBe(true);
  for(const value of ['2026-01-01','2026-12-31','2024-02-29'])expect(payrollDateValidity(value,'','').typeMismatch,value).toBe(false);
  expect(payrollDateValidity('2025-12-31','2026-01-01','2026-12-31').rangeUnderflow).toBe(true);
  expect(payrollDateValidity('2027-01-01','2026-01-01','2026-12-31').rangeOverflow).toBe(true);
  expect(payrollDateValidity('','2026-01-01','2026-12-31')).toEqual({typeMismatch:false,rangeUnderflow:false,rangeOverflow:false});
});
it('explains both date boundaries and the source document without changing the entered values', () => {
  const issue = { ...field, type:'date', name:'decisionDate', value:'2025-11-30', min:'2026-01-01', max:'2026-12-31', rangeUnderflow:true };
  const before = structuredClone(issue);
  const fragments = {fr:'confirmation écrite',de:'schriftlichen Bestätigung',it:'conferma scritta',en:'written confirmation'};
  for(const language of appLanguages){
    const message=payrollFieldMessage(issue,language);
    for(const date of ['30.11.2025','01.01.2026','31.12.2026'])expect(message).toContain(date);
    expect(message).toContain(fragments[language]);
    expect(message).not.toMatch(/\{(?:min|max|value)\}/);
  }
  expect(issue).toEqual(before);
});
it('covers every validation branch, including optional email and contractual precision', () => {
  const variants:Partial<PayrollFieldValidation>[]=[
    {type:'date',typeMismatch:true}, {type:'email',typeMismatch:true}, {type:'email',typeMismatch:true,required:false},
    {valueMissing:true},{valueMissing:true,select:true}, {stepMismatch:true}, {},
    ...['date','number'].flatMap(type=>[
      {type,min:'1',rangeUnderflow:true}, {type,max:'9',rangeOverflow:true}, {type,min:'1',max:'9',rangeOverflow:true},
    ]),
  ];
  for(const patch of variants){const input={...field,...patch};const french=payrollFieldMessage(input,'fr');for(const language of ['de','it','en'] as const)expect(payrollFieldMessage(input,language)).not.toBe(french);}
  expect(payrollFieldMessage({...field,stepMismatch:true},'en')).toContain('Do not change a contractual rate');
  expect(payrollFieldMessage({...field,type:'email',typeMismatch:true,required:false},'en')).toContain('optional field blank');
});
it('keeps correction destinations, raw details, grouping and IDs stable in all four languages', () => {
  const messages=['La date de décision/demande doit être une date réelle dans l’année d’évaluation.','La prime accidents professionnels AAP doit être configurée.','La couverture AANP est manquante.','Le plan LPP exige une référence.','Choisissez le compte wages_expense_account_id.'];
  const reference=payrollPreparationTasks(messages),groups=groupedPayrollHelp(messages);
  expect(reference.some(task=>task.selector==='[name=decisionDate]')).toBe(true);
  for(const language of appLanguages){
    setAppLanguage(language);
    const tasks=payrollPreparationTasks(messages);
    expect(tasks).toEqual(reference);expect(groupedPayrollHelp(messages)).toEqual(groups);
    if(language!=='fr')for(const task of tasks){expect(t(task.title)).not.toBe(task.title);expect(t(task.explanation)).not.toBe(task.explanation);expect(t(task.document)).not.toBe(task.document);}
  }
});
it('has translations for all curated payroll guidance and known field messages', () => {
  const missing:string[]=[];
  const metadata=['payrollHelp.ts','payrollPreparationTasks.ts','payrollFieldLanguage.ts'];
  const screens=['PayrollBasisGuide.tsx','PayrollFieldGuide.tsx','PayrollHourlySalary.tsx','PayrollPensionPair.tsx','PayrollPreparation.tsx','PayrollProblem.tsx'];
  for(const file of [...metadata,...screens]){
    const ast=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node:ts.Node){
      if(ts.isStringLiteral(node)&&/[a-zA-ZÀ-ÿ]/.test(node.text)&&/\s/.test(node.text)&&!node.text.startsWith('[')){
        const parent=node.parent;
        const interfaceCopy=metadata.includes(file)||ts.isCallExpression(parent)&&ts.isIdentifier(parent.expression)&&['t','text','setError','Error'].includes(parent.expression.text);
        if(interfaceCopy&&!translations[node.text.trim()])missing.push(`${file}: ${node.text}`);
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  for(const source of Object.values(payrollBasisNames))if(source&&!translations[source])missing.push(source);
  expect(missing).toEqual([]);
});
