// Isolated UI fixture. No API, account, mailbox or business data is used.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationControlCentre, type AutomationCentreState } from '../src/AutomationControlCentre';
import { AutomationBrief } from '../src/AutomationBrief';
import type { WorkflowDefinition } from '../src/automationWorkflowTypes';
import { setAppearance, type Appearance } from '../src/appearance';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/dark.generated.css';
import '../src/dark.css';
setAppearance('light');
const definition:WorkflowDefinition={trigger:'email_classified',mode:'suggest',threshold:.95,conditions:{category:'after_sales',priority:'',sender:'',attachment:false},decision:{question:'Faut-il une intervention sur place ?',yes:'Déplacement demandé',no:'Aide à distance'},actions:[{type:'reply_draft',title:'Réponse · {{objet}}',body:'Bonjour,\n\nNous avons bien reçu votre message concernant « {{objet}} ». Notre équipe examine votre demande.\n\nMeilleures salutations',delayHours:0,branch:'always',assignedTo:''}]};
const time=Math.floor(Date.now()/1000);
const data:AutomationCentreState={organizationId:'ui-fixture',canManage:true,canWork:true,rules:[{id:'r1',name:'Préparer le suivi après-vente',enabled:true,revision:1,definition}],runs:[{id:'run1',title:'Demande d’intervention — Atelier du Lac',state:'review',revision:1,attempts:1,createdAt:time-1800,updatedAt:time-1780,dueAt:0,definition,result:{choice:'uncertain',confidence:.64,message:'Choisissez la suite avant de préparer la réponse.',summary:{subject:'Notre imprimante ne démarre plus',sender:'atelier@example.test',excerpts:[{text:'Bonjour, notre imprimante ne démarre plus depuis ce matin. Pourriez-vous nous aider avant jeudi ?'}],attachments:['Photo-imprimante.jpg'],truncated:false}}},{id:'run2',title:'Suivi du devis — Aménagement de l’accueil',state:'waiting',revision:2,attempts:1,createdAt:time-3600,updatedAt:time-3600,dueAt:time+86400,definition,result:{message:'La tâche de suivi sera créée demain.'}}],items:[{id:'draft',kind:'reply_draft',title:'Réponse à Atelier du Lac',body:'Bonjour,\n\nNous avons bien reçu votre demande concernant votre imprimante. Notre équipe examine les informations reçues.\n\nMeilleures salutations',state:'open',revision:1,assigned_to:'member',created_at:time-7200}],templates:[{id:'reply',name:'Préparer une réponse',description:'Un modèle partagé, à relire avant l’envoi.',definition}],members:[{user_id:'member',name:'Camille Martin',role:'member'}]};
async function request(body:Record<string,unknown>){
 if(body.action==='centre')return structuredClone(data);
 if(body.action==='workflow_preview')return {matched:true,message:'Simulation des conditions et des modèles. Aucun appel intelligent, aucun envoi et aucune donnée métier modifiée.',actions:[{title:'Réponse · Demande de test',body:'Bonjour, nous avons bien reçu votre message.'}]};
 if(body.action==='workflow_save'){const rule={id:String(body.id||'new'),name:String(body.name),enabled:Boolean(body.enabled),revision:Number(body.revision||0)+1,definition:body.definition as WorkflowDefinition};data.rules=data.rules.filter(r=>r.id!==rule.id).concat(rule);return {saved:true};}
 if(body.action==='work_item_update'){const item=data.items.find(i=>i.id===body.id);if(!item||item.revision!==body.revision)throw Error('Le brouillon a changé.');if(typeof body.body==='string')item.body=body.body;if(typeof body.state==='string')item.state=body.state;item.revision++;return {saved:true};}
 const run=data.runs.find(r=>r.id===body.id);if(run){run.state=body.action==='workflow_cancel'?'cancelled':'completed';run.revision++;}return {saved:true};
}
function Fixture(){const [theme,setTheme]=useState<Appearance>('light'),[view,setView]=useState('today');return <main style={{maxWidth:880,margin:'0 auto',padding:'16px 20px'}}><p>Données fictives · Recette Automation</p><label>Apparence<select value={theme} onChange={e=>{setTheme(e.target.value as Appearance);setAppearance(e.target.value as Appearance);}}><option value="light">Claire</option><option value="dark">Sombre</option></select></label><button onClick={()=>setView('today')}>Aujourd’hui</button>{view==='today'?<AutomationBrief activity={{displayName:'Camille',totals:{analyzed:12,confirmed:3,needsReview:0,observed:0},supplierInbox:{received:12,imported:10,automatic:8,needsReview:2},appointments:{imported:3,pending:1},workflows:{tasks:2,drafts:1,summaries:1,open:1,review:1,observed:0}}} onOpen={destination=>setView(destination)}/>:<AutomationControlCentre organizationId="ui-fixture" initialTab={view==='work'?'work':view==='history'?'history':view==='settings'?'rules':'review'} embedded request={request}/>}</main>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
