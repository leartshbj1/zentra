// Development-only component journey, excluded from the production entry.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageSetting } from '../src/LanguageSetting';
import { t, useAppLanguage } from '../src/language';
import { Field, Button, Modal } from '../src/ui';
import { usePayrollFieldGuide } from '../src/PayrollFieldGuide';
import { PayrollProblem } from '../src/PayrollProblem';
import { PayrollPreparation } from '../src/PayrollPreparation';
import { PayrollHourlySalary } from '../src/PayrollHourlySalary';
import { PayrollBasisGuide } from '../src/PayrollBasisGuide';
import { PayrollPensionPair } from '../src/PayrollPensionPair';
import { payrollBasisQuestions } from '../src/payrollSalaryEntry';
import { payrollPreparationTasks } from '../src/payrollPreparationTasks';
import { revealPayrollField } from '../src/payrollNavigation';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { desktopApi } from '../src/bridge';
import type { Workspace, Account, PayrollContributionDefinition } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/refined.css';
import '../src/payroll-simple.css';
import '../src/payroll-preparation.css';

const rawDate='La date de décision/demande doit être une date réelle dans l’année d’évaluation.';
const messages=[rawDate,'La prime accidents professionnels AAP doit être configurée.','La couverture AANP est manquante.','Le plan LPP exige une référence.'];
const workspace={settings:structuredClone(initialOnboardingSettings)} as Workspace;
workspace.settings!.payroll.lppPlanEvidence={contractNumber:'QA-2026',regulationReference:'Règlement de test {name} 2026',effectiveFrom:'2026-01-01',effectiveTo:'2026-12-31',employerAggregateShareConfirmed:true};
const accounts=[{id:'liability',accountType:'liability',active:true},{id:'expense',accountType:'expense',active:true}] as Account[];
let saved:PayrollContributionDefinition[]=[];
desktopApi.listPayrollContributionDefinitions=async()=>structuredClone(saved);
desktopApi.upsertPayrollContributionDefinition=async input=>{
  if(input.side==='employer'&&sessionStorage.getItem('qa-refuse-employer')==='1')throw Error('Les montants n’ont pas pu être enregistrés. Votre saisie est conservée.');
  const current=saved.findIndex(item=>item.id===input.id);if(current<0)saved.push(structuredClone(input));else saved[current]=structuredClone(input);
  sessionStorage.setItem('qa-pension-saved',JSON.stringify(saved));return input;
};
desktopApi.loadWorkspace=async()=>workspace;
const basisDefinition={id:'basis-qa',category:'ijm',basisKind:'ahv_salary',label:'Contrat assuré {name}',source:'Police de test non traduite',side:'employee'} as PayrollContributionDefinition;
function Journey(){
  useAppLanguage();
  const guide=usePayrollFieldGuide();
  const form=useRef<HTMLFormElement>(null);
  const [mode,setMode]=useState('fields'),[date,setDate]=useState('2025-12-31'),[email,setEmail]=useState(''),[notes,setNotes]=useState('Note employeur {field}\nConditions conservées');
  const [amount,setAmount]=useState<number>(),[done,setDone]=useState(false),[busy,setBusy]=useState(false);
  const questions=payrollBasisQuestions([basisDefinition],[{definitionId:'basis-qa',basisCents:amount}]);
  function fix(target:string,selector?:string){sessionStorage.setItem('qa-destination',JSON.stringify({target,selector}));setMode('fields');requestAnimationFrame(()=>revealPayrollField(form.current,selector??'[name=decisionDate]'));}
  return <Modal title={t('Préparer ma première fiche')} onClose={()=>{}} className="payroll-dialog" assistantHelp={false}>
    <LanguageSetting compact />
    <nav aria-label="QA scenarios" style={{display:'flex',flexWrap:'wrap',gap:8,marginBlock:16}}>{['fields','problems','preparation','hourly','basis','pension'].map(value=><Button type="button" variant="secondary" key={value} data-scenario={value} onClick={()=>{guide.clear();setMode(value);}}>{value}</Button>)}</nav>
    {mode==='fields'&&<form ref={form} noValidate onSubmit={event=>{event.preventDefault();if(guide.check(event.currentTarget))setDone(true);}}>
      {guide.guide}
      <details data-date-details><summary>{t('Dates et référence reprises du contrat')}</summary>
        <Field label={t('Début de validité')} required hint="QA retained description"><input name="decisionDate" aria-describedby="qa-date-hint" type="date" min="2026-01-01" max="2026-12-31" required value={date} onChange={e=>setDate(e.target.value)}/></Field>
      </details>
      <span id="qa-date-hint" hidden>QA retained description</span>
      <Field label={t('E-mail')}><input name="email" type="email" value={email} onChange={e=>setEmail(e.target.value)}/></Field>
      <Field label={t('Notes')}><textarea name="notes" value={notes} onChange={e=>setNotes(e.target.value)}/></Field>
      <Button type="submit" data-check>{t('Continuer')}</Button>
      <output data-raw hidden>{guide.message}</output>{done&&<output data-done>complete</output>}
    </form>}
    {mode==='problems'&&<PayrollProblem messages={messages} onFix={fix}/>}
    {mode==='preparation'&&<PayrollPreparation employeeName="Élodie {name} Dubois" tasks={payrollPreparationTasks(messages)} proposals={[]} busy={false} onApplyProposals={()=>{}} onSaveDraft={()=>{}} onBack={()=>setMode('fields')} onFix={fix} onContinue={()=>{}}/>}
    {mode==='hourly'&&<PayrollHourlySalary busy={false} onPendingChange={()=>{}} onApply={(cents,label)=>sessionStorage.setItem('qa-hourly',JSON.stringify({cents,label}))}/>}
    {mode==='basis'&&<PayrollBasisGuide questions={questions} grossCents={500000} busy={false} onConfirm={(_,patch)=>{setAmount(patch.basisCents);sessionStorage.setItem('qa-basis',JSON.stringify(patch));}} onBack={()=>{}} onComplete={()=>{}} reviewing={false}/>}
    {mode==='pension'&&<PayrollPensionPair workspace={workspace} employeeId="employee-qa" existing={[]} accounts={accounts} disabled={busy} run={async action=>{setBusy(true);try{await action();}finally{setBusy(false);}}}/>}
  </Modal>;
}
createRoot(document.getElementById('root')!).render(<Journey/>);
