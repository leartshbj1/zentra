// Synthetic writes against the production setup components, excluded from the application entry.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PayrollSetup } from '../src/PayrollSetup';
import { Modal, Button } from '../src/ui';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { installPayrollFixture } from './payroll-fixture';
import type { Workspace, AccountingSettings } from '../src/types';
import { desktopApi } from '../src/bridge';
import type { PayrollHelpTarget } from '../src/payrollHelp';
import { t, useAppLanguage } from '../src/language';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/workspace-shell.css';
import '../src/clarity.css';
import '../src/language.css';
import '../src/refined.css';
import '../src/payroll-guided.css';
const original={settings:structuredClone(initialOnboardingSettings),employees:[],payslips:[]} as unknown as Workspace;
desktopApi.getAccountingSettings=async()=>({enabled:true,wagesExpenseAccountId:'expense-qa',wagesPayableAccountId:'social-qa'} as AccountingSettings);
installPayrollFixture(original);
function Journey() {
  useAppLanguage();
  const [workspace,setWorkspace]=useState(original),[target,setTarget]=useState<PayrollHelpTarget>('insurance'),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[closed,setClosed]=useState(false);
  return <Modal title={t('Préparer la paie')} className="payroll-dialog" onClose={()=>{}} assistantHelp={false}>
    <nav style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12}} aria-label="QA scenarios">{['insurance','history','person','accounts','contributions','advanced-contributions'].map(value=><Button key={value} type="button" data-scenario={value} onClick={()=>{setTarget(value as PayrollHelpTarget);setRevision(value=>value+1);setClosed(false);}}>{value}</Button>)}</nav>
    {closed?<output data-closed>saved or returned</output>:<PayrollSetup key={`${target}-${revision}`} initial={target} employeeId="elodie" period="2026-09" contributionDate="2026-09-30" workspace={workspace} busy={busy} onSaved={()=>{}} onClose={()=>setClosed(true)} act={async(action,_message,_close,onError)=>{setBusy(true);try{setWorkspace(await action());return true;}catch(error){onError?.(error);return false;}finally{setBusy(false);}}}/>}
  </Modal>;
}
createRoot(document.getElementById('root')!).render(<Journey/>);
