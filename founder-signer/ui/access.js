'use strict';
const $=id=>document.getElementById(id);
const invoke=(command,args)=>window.__TAURI__.core.invoke(command,args);
let ready=false,busy=false,selected=null,records=[],pending=null,desktop=null;
const isSupport=()=>$('product').value==='support';
const isAutomation=()=>$('product').value==='automation';
const names={zentra:'Zentra Gestion',support:'Zentra Support',automation:'Zentra Automation'};
const productName=()=>names[$('product').value];
const plans={starter:'Starter',team:'Équipe',business:'Business'};
const actionForProduct=action=>$('product').value==='zentra'?action:{...action,product:$('product').value};
function productView(){
  $('support-plan-field').hidden=!isSupport();
  $('product-hint').textContent=isAutomation()?'Option de suggestions et de classement pour l’entreprise du titulaire. Nécessite un accès Zentra Gestion valide.':isSupport()?'Accès à l’espace Support du titulaire et de son équipe. Indépendant de Zentra Gestion.':'Accès individuel Zentra Solo. Automation et Support se donnent séparément.';
  $('offer-summary').textContent=isAutomation()?'Option Automation offerte. Aucun paiement demandé.':isSupport()?'Formule Support offerte. Aucun paiement demandé.':'Accès individuel offert. Aucun paiement demandé.';
}
const formatDate=value=>new Intl.DateTimeFormat('fr-CH',{dateStyle:'long',timeZone:'Europe/Zurich'}).format(new Date(value));
const active=record=>record&&['active','pending'].includes(record.status);
const labels={active:'Actif',pending:'En attente de connexion',expired:'Expiré',revoked:'Retiré'};
function fail(error){$('error').textContent=String(error?.message||error);$('error').hidden=false;}
function clearNotice(){$('error').hidden=true;$('success').hidden=true;}
function updateControls(){
  for(const element of document.querySelectorAll('button,input,select'))element.disabled=busy||!ready;
  $('product').disabled=busy||!ready||!!pending;
  $('grant').disabled=busy||!ready||!selected||!!pending||(isAutomation()&&!$('automation-company-field').hidden&&!$('automation-company').value);
  $('automation-company').disabled=busy||!ready||!!selected?.record?.organizationId;
  $('confirm-revoke').disabled=busy||!ready||!selected||!!pending;
  $('use-desktop-account').disabled=busy||!ready||!desktop?.connected;
  $('pending').hidden=!pending;
  if(pending)$('pending-description').textContent=`${pending.operation==='revoke'?'Retrait':'Attribution'} ${names[pending.product||'zentra']} pour ${pending.email}. Reprenez-la avant une autre modification.`;
}
async function syncStatus(){const status=await invoke('founder_status');ready=status.ready;pending=status.pending;$('key-status').textContent=status.ready?'Votre clé personnelle est prête':status.message;updateControls();}
async function task(callback){if(busy)return;busy=true;updateControls();try{await callback();}catch(e){fail(e);}finally{try{await syncStatus();}catch(e){fail(e);}busy=false;updateControls();}}
function renderRecords(){
  $('records').replaceChildren();const shown=records.filter(r=>$('show-all').checked||active(r));
  if(!shown.length){const p=document.createElement('p');p.className='muted';p.textContent='Aucun accès en cours. Ajoutez un e-mail pour commencer.';$('records').append(p);}
  for(const record of shown){const button=document.createElement('button');button.className='record'+(selected?.email===record.email?' selected':'');button.disabled=busy||!ready;
    const email=document.createElement('b');email.textContent=record.email;const detail=document.createElement('small');detail.textContent=`${record.plan?plans[record.plan]+' · ':''}${labels[record.status]} · ${formatDate(record.expiresAt)}`;button.append(email,detail);
    button.addEventListener('click',()=>task(async()=>{clearNotice();$('email').value=record.email;await lookup(record.email);}));$('records').append(button);
  }
  if(records.length===100){const p=document.createElement('p');p.className='muted';p.textContent='100 accès récents. Recherchez un e-mail pour les autres.';$('records').append(p);}
}
async function list(){const result=await invoke('founder_request',{action:actionForProduct({operation:'list'})});records=result.records;renderRecords();}
function durationHint(){const duration=document.querySelector('[name=duration]:checked').value;$('custom-field').hidden=duration!=='custom';
  $('duration-hint').textContent=duration==='custom'?'L’accès se termine à la fin de la date choisie, heure suisse.':active(selected?.record)?'Cette durée sera ajoutée à la fin de l’accès offert en cours.':'La durée commence dès la confirmation du serveur.';
}
function showAccount(result){
  if(selected?.email!==result.email){document.querySelector('[name=duration][value="14_days"]').checked=true;$('custom-date').value='';}
  selected=result;const r=result.record;$('account').hidden=false;$('email').value=result.email;$('account-title').textContent=result.email;
  if(isSupport())$('support-plan').value=r?.plan||'starter';productView();
  $('automation-company-field').hidden=!isAutomation()||!(result.organizations?.length);
  $('automation-company').replaceChildren();
  if(isAutomation()){
    const choices=result.organizations||[];
    if((choices.length>1||choices.some(c=>c.deviceAccount))&&!r?.organizationId){const option=document.createElement('option');option.value='';option.textContent='Choisir une entreprise';$('automation-company').append(option);}
    for(const company of choices){const option=document.createElement('option');option.value=company.id;option.textContent=company.name+(desktop?.organizationId===company.id?' · App ouverte sur ce PC':company.deviceAccount?' · Compte connecté sur un appareil':'');$('automation-company').append(option);}
    if(r?.organizationId)$('automation-company').value=r.organizationId;
    else if(desktop?.email===result.email&&choices.some(c=>c.id===desktop.organizationId))$('automation-company').value=desktop.organizationId;
  }
  $('account-state').textContent=r?labels[r.status]:result.accountKnown?'Compte reconnu':'Première attribution';
  if(isAutomation()&&r?.status==='pending')$('account-state').textContent='En attente de rattachement';
  $('account-description').textContent=r?.accountLinked?`Cet accès est lié ${isSupport()?'à l’espace Zentra Support':'au compte Zentra'} de cette personne.`:result.accountKnown?`Le compte est connu. L’accès sera rattaché à son espace ${productName()}.`:'L’accès sera récupéré lorsque la personne se connectera avec cette adresse e-mail confirmée.';
  if(isAutomation())$('account-description').textContent=({ready:'L’entreprise est prête à recevoir Automation. Le client choisit ensuite ses suggestions et confirme leur utilisation dans son compte.',gestion_required:'L’offre Automation sera enregistrée. Un accès Zentra Gestion valide est aussi nécessaire : vous pouvez le donner séparément dans cette app.',organization_ambiguous:'Ce titulaire possède plusieurs entreprises. Choisissez celle qui recevra Automation.',organization_required:'L’offre restera en attente d’une entreprise dont cette personne est titulaire. Automation ne crée pas d’accès Gestion.',account_required:'L’offre sera rattachée après connexion avec cet e-mail confirmé, à l’entreprise dont la personne est titulaire. Un accès Gestion valide est nécessaire.'})[result.availability]||'Option Automation liée à l’entreprise du titulaire.';
  $('desktop-mismatch').hidden=!(desktop?.connected&&desktop.email!==result.email);
  $('desktop-mismatch').textContent=desktop?.connected?`Attention : l’app de ce PC est connectée avec ${desktop.email}. Cet accès est destiné à ${result.email} et ne s’affichera pas sur ce compte différent.`:'';
  $('current').hidden=!active(r);if(r)$('current-date').textContent=formatDate(r.expiresAt);
  $('note').value=r?.note||'';$('grant').replaceChildren(document.createTextNode(active(r)?'Prolonger l’accès':'Accorder l’accès'));
  $('revoke-area').hidden=!active(r);$('revoke-confirm').hidden=true;$('revoke').hidden=false;durationHint();renderRecords();updateControls();
}
async function lookup(email){const result=await invoke('founder_request',{action:actionForProduct({operation:'lookup',email:email.trim().toLowerCase()})});showAccount(result);}
async function apply(action){
  $('product').value=action.product||'zentra';productView();
  const result=await invoke('founder_request',{action});showAccount(result);
  $('success').hidden=false;$('success-title').textContent=action.operation==='revoke'?'Accès offert retiré':`Accès accordé jusqu’au ${formatDate(result.record.expiresAt)}`;
  $('success-description').textContent=action.operation==='revoke'?`L’accès offert ${productName()} de ${result.email} est retiré. Le changement sera pris en compte à la prochaine vérification en ligne.`:isSupport()?`${result.email} peut se connecter sur zentraapp.ch/support/espace avec son adresse confirmée. Formule ${plans[result.record.plan]}.`:result.record.status==='pending'?`${result.email} pourra récupérer son accès en se connectant à Zentra avec cette adresse confirmée.`:`${result.email} peut ouvrir ou reconnecter son application Zentra pour récupérer son accès.`;
  if(isAutomation()&&action.operation==='grant'){$('success-title').textContent=`Automation offert jusqu’au ${formatDate(result.record.expiresAt)}`;$('success-description').textContent=`${result.email} retrouvera l’option sur zentraapp.ch/compte/automation. `+(result.availability==='ready'?'Le client choisit les suggestions et confirme leur utilisation. Son application récupère l’accès en ligne.':$('account-description').textContent);}
  try{await list();}catch{fail('La modification est confirmée. La liste des accès sera actualisée à la prochaine connexion.');}
  $('success').scrollIntoView({block:'nearest',behavior:'smooth'});
}
$('lookup-form').addEventListener('submit',event=>{event.preventDefault();task(async()=>{clearNotice();selected=null;$('account').hidden=true;await lookup($('email').value);});});
$('email').addEventListener('input',()=>{selected=null;$('account').hidden=true;clearNotice();updateControls();renderRecords();});
$('new').addEventListener('click',()=>{selected=null;$('email').value='';$('account').hidden=true;clearNotice();renderRecords();updateControls();$('email').focus();});
$('reload').addEventListener('click',()=>task(async()=>{clearNotice();await list();if(selected)await lookup(selected.email);}));
$('show-all').addEventListener('change',renderRecords);
$('product').addEventListener('change',()=>task(async()=>{clearNotice();selected=null;records=[];$('account').hidden=true;$('email').value='';productView();renderRecords();await list();}));
for(const radio of document.querySelectorAll('[name=duration]'))radio.addEventListener('change',durationHint);
$('automation-company').addEventListener('change',updateControls);
$('use-desktop-account').addEventListener('click',()=>task(async()=>{if(!desktop?.connected)return;clearNotice();await lookup(desktop.email);}));
$('grant').addEventListener('click',()=>task(async()=>{if(!selected)return;clearNotice();const duration=document.querySelector('[name=duration]:checked').value;
  if(duration==='custom'&&!$('custom-date').value)throw new Error('Choisissez le dernier jour d’accès.');
  await apply(actionForProduct({operation:'grant',email:selected.email,duration,customDate:duration==='custom'?$('custom-date').value:'',note:$('note').value,expectedRevision:selected.record?.revision||0,operationId:crypto.randomUUID(),...(isSupport()?{plan:$('support-plan').value}:{}),...(isAutomation()&&$('automation-company').value?{organizationId:$('automation-company').value}:{})}));
}));
$('revoke').addEventListener('click',()=>{$('revoke-confirm').hidden=false;$('revoke').hidden=true;$('revoke-email').textContent=selected.email;});
$('cancel-revoke').addEventListener('click',()=>{$('revoke-confirm').hidden=true;$('revoke').hidden=false;});
$('confirm-revoke').addEventListener('click',()=>task(async()=>{if(!selected)return;clearNotice();await apply(actionForProduct({operation:'revoke',email:selected.email,note:$('note').value,expectedRevision:selected.record.revision,operationId:crypto.randomUUID()}));}));
$('retry').addEventListener('click',()=>task(async()=>{if(!pending)return;clearNotice();await apply(pending);}));
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());$('custom-date').min=today;
task(async()=>{await syncStatus();if(pending)$('product').value=pending.product||'zentra';productView();if(ready){await list();try{desktop=await invoke('desktop_account');$('desktop-account').textContent=desktop.connected?`Compte du PC : ${desktop.email} · ${desktop.organizationName}`:desktop.message;}catch{$('desktop-account').textContent='Le compte du PC n’a pas pu être vérifié.';}}else fail($('key-status').textContent);});
