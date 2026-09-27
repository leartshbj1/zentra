// Isolated UI fixture. No account, mailbox or network service is used.
import {createRoot} from 'react-dom/client';
import {AutomationRunRow, type AutomationCentreState} from '../src/AutomationControlCentre';
import {setAppLanguage, type AppLanguage} from '../src/language';
import {setAppearance} from '../src/appearance';
import '../src/styles.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
import '../src/automation-design.css';
const query=new URLSearchParams(location.search);
const language=query.get('language')||'fr';
await setAppLanguage(language as AppLanguage);
setAppearance(query.get('theme')==='dark'?'dark':'light');
const run:AutomationCentreState['runs'][number]={id:'fixture-run',title:'Demande d’intervention · Atelier du Lac',state:query.get('state')||'review',revision:7,attempts:2,createdAt:0,updatedAt:Infinity,dueAt:Infinity,
 definition:{trigger:'email_classified',mode:'suggest',threshold:.95,conditions:{category:'after_sales',priority:'',sender:'',attachment:false},decision:{question:'Choix interne',yes:'Visite sur place',no:'Aide à distance'},actions:[{type:'reply_draft',title:'Réponse · {{objet}}',body:'',delayHours:0,branch:'always',assignedTo:''}]},
 result:{choice:'uncertain',confidence:.72,message:'Le lieu de l’intervention est à confirmer avant de préparer la réponse.',summary:{subject:'Notre imprimante ne démarre plus',sender:'atelier@example.test',excerpts:[{text:'Bonjour, notre imprimante ne démarre plus depuis ce matin. Pouvez-vous nous aider avant jeudi ?'}],attachments:['Photo-imprimante.jpg'],truncated:true}}};
Object.assign(window,{__runActions:[]});
createRoot(document.getElementById('root')!).render(<main className="workspace" style={{minHeight:'100vh',display:'block',padding:'24px',maxWidth:900,margin:'0 auto'}}><section className="automation-centre automation-centre--embedded"><AutomationRunRow run={run} canManage={query.get('role')!=='reader'} busy={query.get('busy')==='1'} act={async value=>{(window as unknown as {__runActions:unknown[]}).__runActions.push(value);}}/></section></main>);
