// Synthetic local fixture; no account, message or business write.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AutomationJournal} from '../src/AutomationJournal';
import {AgendaScreen} from '../src/AgendaScreen';
import {AppointmentInbox} from '../src/AppointmentInbox';
import {setAppLanguage,type AppLanguage} from '../src/language';
import {setAppearance} from '../src/appearance';
import {automationLabel} from '../src/automationPresentation';
import {appointmentInboxFixture,appointmentWorkspace} from './appointment-activity-fixture';
import '../src/styles.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
import '../src/AutomationControlCentre.css';
import '../src/AutomationHub.css';
import '../src/automation-design.css';
const query=new URLSearchParams(location.search),language=(query.get('language')||'fr') as AppLanguage;
await setAppLanguage(language);setAppearance(query.get('theme')==='dark'?'dark':'light');
const readOnly=query.get('role')==='reader';
function Harness(){
 const [view,setView]=useState('automation'),[target,setTarget]=useState<string|null>(null),[org,setOrg]=useState('company-a'),[revision,setRevision]=useState(0);
 Object.assign(window,{__appointmentQa:{setOrg,setAppearance,refresh:()=>setRevision(r=>r+1),revision}});
 const open=(id:string)=>{setTarget(id);setView('agenda');};
 const inbox={state:appointmentInboxFixture,error:'',busy:false,act:async()=>{throw Error('No writes in this fixture');}};
 return <div className="desktop-app" data-experience="clarity" style={{display:'block'}}><main className="workspace" style={{minHeight:'100vh',display:'block',padding:query.get('size')==='small'?'12px':'24px',maxWidth:1120,margin:'0 auto'}}>
  {view!=='automation'&&<button type="button" data-testid="back" onClick={()=>{setView('automation');setTarget(null);}}>Automation</button>}
  {view==='automation'?<div className="automation-hub"><div className="automation-hub__journal"><div className="automation-centre automation-centre--embedded"><AutomationJournal organizationId={org} appointments={appointmentInboxFixture} runs={[{id:'older',title:'Document préparé',state:'completed',createdAt:1790510250,updatedAt:0}]} renderRun={run=><span>{run.title}</span>} openAppointment={open} openAppointments={()=>setView('received')}/></div></div></div>
   :view==='received'?<AppointmentInbox inbox={inbox} workspace={appointmentWorkspace} readOnly={readOnly} onAgenda={()=>setView('agenda')} onOpenAppointment={open}/>
   :<AgendaScreen workspace={{...appointmentWorkspace}} initialEventId={query.has('missing')?'missing':target} onInitialEventHandled={()=>setTarget(null)} readOnly={readOnly} busy={false} onSave={async()=>{throw Error('Unexpected write');}} onDelete={async()=>{throw Error('Unexpected delete');}} onNavigate={()=>{}}/>}
  <span hidden>{automationLabel('appointments',language)}</span>
 </main></div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
