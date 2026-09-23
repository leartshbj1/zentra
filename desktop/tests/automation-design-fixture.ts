import type { AutomationCentreState } from '../src/AutomationControlCentre';
import type { AutomationState } from '../src/automation';
import type { WorkflowDefinition } from '../src/automationWorkflowTypes';

/** Fictitious UI-only records. Never sent to a mailbox, company or API. */
export function automationDesignFixture(state: AutomationState): AutomationCentreState {
  const now = Math.floor(Date.now() / 1000);
  const definition: WorkflowDefinition = {trigger:'email_classified',mode:'suggest',threshold:.95,conditions:{category:'after_sales',priority:'',sender:'',attachment:false},decision:{question:'Une intervention sur place est-elle nécessaire ?',yes:'Intervention sur place',no:'Aide à distance'},actions:[{type:'reply_draft',title:'Réponse · {{objet}}',body:'Bonjour, nous avons bien reçu votre demande. Notre équipe revient vers vous.',delayHours:0,branch:'always',assignedTo:''}]};
  state.activity = {...state.activity!,date:new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Zurich'}),updatedAt:now,
    workflows:{tasks:2,drafts:1,summaries:1,open:2,review:1,observed:0},
    totals:{analyzed:12,suggestions:4,confirmed:3,needsReview:0,observed:0},
    supplierInbox:{received:6,imported:4,automatic:3,needsReview:2,recent:[
      {id:'ui-invoice-1',subject:'Papeterie du Léman · LEMAN-2026-091',state:'imported',automatic:1,imported_at:now-420},
      {id:'ui-invoice-2',subject:'Studio Romandie · STUDIO-2026-067',state:'imported',automatic:0,imported_at:now-2400},
      {id:'ui-invoice-3',subject:'Atelier électrique · ELEC-2026-082',state:'needs_review',automatic:0,imported_at:0},
    ]},
  };
  return {organizationId:state.organizationId,canManage:state.canManage,canWork:true,
    rules:[{id:'ui-rule',name:'Préparer le suivi après-vente',enabled:true,revision:1,definition}],
    runs:[
      {id:'ui-run-1',title:'Demande d’intervention · Atelier du Lac',state:'review',revision:1,attempts:1,createdAt:now-1500,updatedAt:now-1200,dueAt:0,definition,result:{choice:'uncertain',confidence:.64,message:'Le lieu de l’intervention est à confirmer avant de préparer la réponse.',summary:{subject:'Notre imprimante ne démarre plus',sender:'atelier@example.test',excerpts:[{text:'Bonjour, notre imprimante ne démarre plus depuis ce matin. Pouvez-vous nous aider avant jeudi ?'}],attachments:['Photo-imprimante.jpg'],truncated:false}}},
      {id:'ui-run-2',title:'Réponse préparée · Maison Laurent',state:'completed',revision:2,attempts:1,createdAt:now-3000,updatedAt:now-2900,dueAt:0,definition,result:{message:'Le brouillon attend une relecture dans À faire.',steps:[{index:0,type:'reply_draft',title:'Réponse · Maison Laurent',state:'completed',at:now-2900}]}},
      {id:'ui-run-3',title:'Suivi du devis · Aménagement de l’accueil',state:'waiting',revision:1,attempts:1,createdAt:now-4000,updatedAt:now-4000,dueAt:now+86400,definition,result:{message:'La tâche de suivi sera créée demain.'}},
      {id:'ui-run-4',title:'Résumé préparé · Projet des bureaux',state:'completed',revision:1,attempts:1,createdAt:now-86400,updatedAt:now-86400,dueAt:0,definition,result:{message:'Les informations du message sont regroupées dans le résumé.'}},
    ],
    items:[{id:'ui-draft',title:'Réponse à Maison Laurent',body:'Bonjour,\n\nNous avons bien reçu votre demande. Notre équipe examine les informations reçues.\n\nMeilleures salutations',kind:'reply_draft',state:'open',revision:1,assigned_to:'ui-member',created_at:now-2900},{id:'ui-task',title:'Relire la demande du client',body:'Vérifier les informations reçues avant de poursuivre.',kind:'task',state:'open',revision:1,assigned_to:'ui-member',created_at:now-4000}],
    templates:[{id:'ui-template',name:'Préparer une réponse',description:'Un modèle partagé, à relire avant envoi.',definition}],members:[{user_id:'ui-member',name:'Camille Martin',role:'member'}],
  };
}
