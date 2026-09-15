'use strict';
const $=id=>document.getElementById(id);
const invoke=(command,args)=>window.__TAURI__.core.invoke(command,args);
let ready=false,busy=false,selected=null,records=[],pending=null;
const formatDate=value=>new Intl.DateTimeFormat('fr-CH',{dateStyle:'long',timeZone:'Europe/Zurich'}).format(new Date(value));
const active=record=>record&&['active','pending'].includes(record.status);
const labels={active:'Actif',pending:'En attente de connexion',expired:'Expiré',revoked:'Retiré'};
function fail(error){$('error').textContent=String(error?.message||error);$('error').hidden=false;}
function clearNotice(){$('error').hidden=true;$('success').hidden=true;}
function updateControls(){
  for(const element of document.querySelectorAll('button,input'))element.disabled=busy||!ready;
  $('grant').disabled=busy||!ready||!selected||!!pending;
  $('confirm-revoke').disabled=busy||!ready||!selected||!!pending;
  $('pending').hidden=!pending;
  if(pending)$('pending-description').textContent=`${pending.operation==='revoke'?'Retrait':'Attribution'} pour ${pending.email}. Reprenez-la avant une autre modification.`;
}
async function syncStatus(){const status=await invoke('founder_status');ready=status.ready;pending=status.pending;$('key-status').textContent=status.ready?'Votre clé personnelle est prête':status.message;updateControls();}
async function task(callback){if(busy)return;busy=true;updateControls();try{await callback();}catch(e){fail(e);}finally{try{await syncStatus();}catch(e){fail(e);}busy=false;updateControls();}}
function renderRecords(){
  $('records').replaceChildren();const shown=records.filter(r=>$('show-all').checked||active(r));
  if(!shown.length){const p=document.createElement('p');p.className='muted';p.textContent='Aucun accès en cours. Ajoutez un e-mail pour commencer.';$('records').append(p);}
  for(const record of shown){const button=document.createElement('button');button.className='record'+(selected?.email===record.email?' selected':'');button.disabled=busy||!ready;
    const email=document.createElement('b');email.textContent=record.email;const detail=document.createElement('small');detail.textContent=`${labels[record.status]} · ${formatDate(record.expiresAt)}`;button.append(email,detail);
    button.addEventListener('click',()=>task(async()=>{clearNotice();$('email').value=record.email;await lookup(record.email);}));$('records').append(button);
  }
  if(records.length===100){const p=document.createElement('p');p.className='muted';p.textContent='100 accès récents. Recherchez un e-mail pour les autres.';$('records').append(p);}
}
async function list(){const result=await invoke('founder_request',{action:{operation:'list'}});records=result.records;renderRecords();}
function durationHint(){const duration=document.querySelector('[name=duration]:checked').value;$('custom-field').hidden=duration!=='custom';
  $('duration-hint').textContent=duration==='custom'?'L’accès se termine à la fin de la date choisie, heure suisse.':active(selected?.record)?'Cette durée sera ajoutée à la fin de l’accès offert en cours.':'La durée commence dès la confirmation du serveur.';
}
function showAccount(result){
  if(selected?.email!==result.email){document.querySelector('[name=duration][value="14_days"]').checked=true;$('custom-date').value='';}
  selected=result;const r=result.record;$('account').hidden=false;$('email').value=result.email;$('account-title').textContent=result.email;
  $('account-state').textContent=r?labels[r.status]:result.accountKnown?'Compte reconnu':'Première attribution';
  $('account-description').textContent=r?.accountLinked?'Cet accès est lié au compte Zentra de cette personne.':result.accountKnown?'Le compte est connu de Zentra. L’accès sera rattaché à son espace personnel.':'L’accès sera récupéré lorsque la personne se connectera avec cette adresse e-mail confirmée.';
  $('current').hidden=!active(r);if(r)$('current-date').textContent=formatDate(r.expiresAt);
  $('note').value=r?.note||'';$('grant').replaceChildren(document.createTextNode(active(r)?'Prolonger l’accès':'Accorder l’accès'));
  $('revoke-area').hidden=!active(r);$('revoke-confirm').hidden=true;$('revoke').hidden=false;durationHint();renderRecords();updateControls();
}
async function lookup(email){const result=await invoke('founder_request',{action:{operation:'lookup',email:email.trim().toLowerCase()}});showAccount(result);}
async function apply(action){
  const result=await invoke('founder_request',{action});showAccount(result);
  $('success').hidden=false;$('success-title').textContent=action.operation==='revoke'?'Accès offert retiré':`Accès accordé jusqu’au ${formatDate(result.record.expiresAt)}`;
  $('success-description').textContent=action.operation==='revoke'?`L’accès offert de ${result.email} est retiré. Le changement sera pris en compte à la prochaine vérification en ligne.`:result.record.status==='pending'?`${result.email} pourra récupérer son accès en se connectant à Zentra avec cette adresse confirmée.`:`${result.email} peut ouvrir ou reconnecter son application Zentra pour récupérer son accès.`;
  try{await list();}catch{fail('La modification est confirmée. La liste des accès sera actualisée à la prochaine connexion.');}
  $('success').scrollIntoView({block:'nearest',behavior:'smooth'});
}
$('lookup-form').addEventListener('submit',event=>{event.preventDefault();task(async()=>{clearNotice();selected=null;$('account').hidden=true;await lookup($('email').value);});});
$('email').addEventListener('input',()=>{selected=null;$('account').hidden=true;clearNotice();updateControls();renderRecords();});
$('new').addEventListener('click',()=>{selected=null;$('email').value='';$('account').hidden=true;clearNotice();renderRecords();updateControls();$('email').focus();});
$('reload').addEventListener('click',()=>task(async()=>{clearNotice();await list();if(selected)await lookup(selected.email);}));
$('show-all').addEventListener('change',renderRecords);
for(const radio of document.querySelectorAll('[name=duration]'))radio.addEventListener('change',durationHint);
$('grant').addEventListener('click',()=>task(async()=>{if(!selected)return;clearNotice();const duration=document.querySelector('[name=duration]:checked').value;
  if(duration==='custom'&&!$('custom-date').value)throw new Error('Choisissez le dernier jour d’accès.');
  await apply({operation:'grant',email:selected.email,duration,customDate:duration==='custom'?$('custom-date').value:'',note:$('note').value,expectedRevision:selected.record?.revision||0,operationId:crypto.randomUUID()});
}));
$('revoke').addEventListener('click',()=>{$('revoke-confirm').hidden=false;$('revoke').hidden=true;$('revoke-email').textContent=selected.email;});
$('cancel-revoke').addEventListener('click',()=>{$('revoke-confirm').hidden=true;$('revoke').hidden=false;});
$('confirm-revoke').addEventListener('click',()=>task(async()=>{if(!selected)return;clearNotice();await apply({operation:'revoke',email:selected.email,note:$('note').value,expectedRevision:selected.record.revision,operationId:crypto.randomUUID()});}));
$('retry').addEventListener('click',()=>task(async()=>{if(!pending)return;clearNotice();await apply(pending);}));
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());$('custom-date').min=today;
task(async()=>{await syncStatus();if(ready)await list();else fail($('key-status').textContent);});
