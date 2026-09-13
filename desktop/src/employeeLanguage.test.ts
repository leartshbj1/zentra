import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { appLanguages, setAppLanguage, t, type InterfaceMessage } from './language';
import { translations } from './translations';
import { employeeFormIssue, employeeNativeFieldIssue } from './employeeFormValidation';
import { parseSmallSalaryEmployeeForm, SmallSalaryFormError, type SmallSalaryEmployeeFormDraft } from './smallSalaryAssessment';
import { employeeDocumentErrorMessage, employeeDocumentProgress, employeeSaveMessage } from './employeeLanguage';

afterEach(()=>setAppLanguage('fr'));
const render=(issue:{message:string;presentation?:InterfaceMessage})=>issue.presentation?t(issue.presentation.source,issue.presentation.values):t(issue.message);
const form=(input:Record<string,string>)=>{const value=new FormData();for(const [key,text]of Object.entries(input))value.set(key,text);return value;};
const draft:SmallSalaryEmployeeFormDraft={assessmentYear:'2026',sector:'ordinary',employeeRequestedContributions:'no',decisionDate:'2026-01-12',openingGross:'0',openingContributedBasis:'0',evidenceReference:'Déclaration {year} du salarié'};
function annualIssue(input:SmallSalaryEmployeeFormDraft){try{parseSmallSalaryEmployeeForm(input);}catch(error){if(error instanceof SmallSalaryFormError)return error;throw error;}throw Error('Expected an annual validation issue');}

it('translates every missing annual field and keeps its correction destination',()=>{
  for(const name of Object.keys(draft)){
    const input={...draft,[name]:''},issue=annualIssue(input),before=structuredClone(input);
    for(const language of appLanguages){setAppLanguage(language);if(language!=='fr')expect(render(issue),issue.message).not.toBe(issue.message);expect(annualIssue(input).field).toBe(issue.field);}
    expect(input).toEqual(before);
  }
});
it('keeps both years and the real entered date in a translated annual diagnostic',()=>{
  const issue=annualIssue({...draft,decisionDate:'2025-12-31'});
  for(const language of appLanguages){setAppLanguage(language);const message=render(issue);expect(message).toContain('2026');expect(message).toContain('31.12.2025');expect(message).not.toMatch(/\{year\}|\{date\}/);expect(issue.field).toBe('smallSalaryDecisionDate');}
  expect(issue.message).toContain('L’année choisie est 2026');
});
it('translates invalid annual values and preserves the original parser decisions',()=>{
  const variants=[{assessmentYear:'99'},{sector:'wrong'},{employeeRequestedContributions:'wrong'},{decisionDate:'2026-02-29'},{openingGross:'abc'},{openingContributedBasis:'abc'},{openingGross:'10',openingContributedBasis:'20'},{evidenceReference:'x'.repeat(501)}];
  for(const patch of variants){const issue=annualIssue({...draft,...patch});for(const language of ['de','it','en'] as const){setAppLanguage(language);expect(render(issue),issue.message).not.toBe(issue.message);}}
  for(const language of appLanguages){setAppLanguage(language);expect(parseSmallSalaryEmployeeForm(draft).smallSalaryEvidenceReference).toBe(draft.evidenceReference);expect(parseSmallSalaryEmployeeForm(draft).smallSalaryOpeningGrossCents).toBe(0);}
});
it('explains missing paired year/amount fields, including defer instructions only on new employees',()=>{
  for(const [year,amount]of [['lppAssessmentYear','lppAnnualSalary'],['acOpeningYear','acOpeningBasis'],['laaOpeningYear','laaOpeningBasis']])for(const isNew of [false,true]){
    for(const input of [{[year]:'2026'},{[amount]:'0'}]){
      const data=form(input),issue=employeeFormIssue(data,'all',isNew)!;
      setAppLanguage('fr');expect(render(issue)).toBe(issue.message);
      for(const language of ['de','it','en']as const){setAppLanguage(language);expect(render(issue),issue.message).not.toBe(issue.message);}
      expect(employeeFormIssue(data,'all',isNew)).toEqual(issue);
      if(input[year])expect(render(issue)).toContain('2026');
    }
  }
});
it('keeps recognized native errors linked to stable employee fields',()=>{
  for(const message of ['IBAN invalide','social_security_number invalide','date de naissance invalide','employment_end_date invalide']){
    const issue=employeeNativeFieldIssue(message)!;
    for(const language of ['de','it','en']as const){setAppLanguage(language);expect(render(issue)).not.toBe(issue.message);expect(employeeNativeFieldIssue(message)).toEqual(issue);}
  }
});
it('uses plain translated progress and keeps technical save details out of the main instruction',()=>{
  for(const language of ['de','it','en']as const){setAppLanguage(language);for(const label of ['Téléchargement local · model.gguf','OCR page 2','Ouverture du document','32/384 jetons']){const message=employeeDocumentProgress(label);expect(message).not.toBe(label);expect(message).not.toContain('jetons');}expect(employeeSaveMessage('SQLITE_BUSY: database locked')).not.toContain('SQLITE');expect(employeeDocumentErrorMessage('WASM allocation failed')).not.toContain('WASM');}
});
it('covers every explicit key in the complete employee form and team directory, including one-word buttons',()=>{
  const missing:string[]=[];
  function check(node:ts.Expression){
    if(ts.isStringLiteral(node)){const key=node.text.trim();if(key&&!translations[key])missing.push(key);}
    else if(ts.isConditionalExpression(node)){check(node.whenTrue);check(node.whenFalse);}
    else if(ts.isElementAccessExpression(node)&&ts.isArrayLiteralExpression(node.expression))node.expression.elements.forEach(check);
  }
  for(const file of ['WorkspaceApp.tsx','EmployeeDocumentImport.tsx','employeeLanguage.ts']){
    const ast=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node:ts.Node){
      if(file==='WorkspaceApp.tsx'&&ts.isFunctionDeclaration(node)&&!['EmployeeForm','TeamScreen'].includes(node.name?.text??''))return;
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='t'&&node.arguments[0])check(node.arguments[0]);
      ts.forEachChild(node,visit);
    }visit(ast);
  }
  expect(missing).toEqual([]);
});
