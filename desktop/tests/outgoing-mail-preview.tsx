// Development-only fixture. Never transmits email or contacts an SMTP server.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MailComposer, MailSettings } from '../src/OutgoingMailPanel';
import { outgoingMail, type MailState } from '../src/outgoingMail';
import { Button } from '../src/ui';
import { setAppearance } from '../src/appearance';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
const params = new URLSearchParams(location.search);
const logoCanvas=document.createElement('canvas');logoCanvas.width=360;logoCanvas.height=90;
const logoContext=logoCanvas.getContext('2d')!;logoContext.fillStyle='#224c3c';logoContext.font='bold 30px Georgia';logoContext.fillText('ATELIER DU LÉMAN',8,55);
const companyLogo=params.has('noLogo')?null:logoCanvas.toDataURL('image/png');
setAppearance(params.get('theme') === 'dark' ? 'dark' : 'light');
const sample={subject:'Votre facture {numero} — {entreprise}',body:'Bonjour {client},\n\nVous trouverez en pièce jointe notre facture {numero}, d’un montant de {montant}, payable jusqu’au {echeance}.\n\nNous vous remercions de votre confiance.\n\nAtelier du Léman\n{email_entreprise}'};
let state:MailState={scope:'fixture-company',connection:{connected:params.has('connected'),fromName:'Atelier du Léman',fromEmail:'contact@example.invalid',host:'mail.infomaniak.com',port:465,security:'tls',username:'contact@example.invalid'},templates:{quotes:{...sample,subject:'Votre devis {numero} — {entreprise}'},invoices:sample},signature:{includeCompanyLogo:params.has('logo')},companyLogoDataUrl:companyLogo,canConfigure:!params.has('readOnly')};
const qa={sends:0,connections:0,templates:0,fail:params.has('fail'),failConnection:false,inputs:[] as unknown[],connectionInputs:[] as Record<string,unknown>[]};
// Keep the real connect bridge: its IPC payload must meet the strict native schema.
Object.assign(window,{__mailQa:qa,__TAURI_INTERNALS__:{invoke:async(command:string,args:{scope:string;connection:Record<string,unknown>})=>{
  if(command!=='connect_outgoing_mail')throw Error(`Unexpected native command: ${command}`);
  const allowed=['host','port','security','username','fromEmail','fromName','password'];
  const unexpected=Object.keys(args.connection).find(key=>!allowed.includes(key));
  if(unexpected)throw Error(`invalid args connection for command connect_outgoing_mail: unknown field ${unexpected}`);
  if(args.scope!==state.scope||allowed.some(key=>!(key in args.connection)))throw Error('Incomplete native connection request');
  qa.connections++;qa.connectionInputs.push({...args.connection,password:args.connection.password?'supplied':'kept'});
  if(qa.failConnection)throw Error('La messagerie a refusé la connexion. Vérifiez l’identifiant et le mot de passe de la boîte.');
  const {password:_,...visible}=args.connection;
  state={...state,connection:{...visible,connected:true}};return structuredClone(state.connection);
}}});
outgoingMail.state=async()=>structuredClone(state);
outgoingMail.disconnect=async()=>{state={...state,connection:{connected:false}};};
outgoingMail.saveTemplates=async(_,templates,signature)=>{qa.templates++;state={...state,templates,...(signature?{signature}:{})};};
outgoingMail.preview=async target=>({scope:state.scope,target,sourceRevision:'revision-1',recipient:'client@example.invalid',subject:'Votre facture F-2026-0142 — Atelier du Léman',body:'Bonjour Camille,\n\nVous trouverez en pièce jointe notre facture F-2026-0142, d’un montant de 1’250.00 CHF, payable jusqu’au 30.10.2026.\n\nNous vous remercions de votre confiance.\n\nAtelier du Léman\ncontact@example.invalid',signatureLogoDataUrl:state.signature?.includeCompanyLogo?state.companyLogoDataUrl:null,signatureLogoError:state.signature?.includeCompanyLogo&&!state.companyLogoDataUrl?'Ajoutez ou réimportez votre logo dans Paramètres → Entreprise, ou désactivez le logo dans les réglages des e-mails.':null,attachmentName:'Facture-F-2026-0142.pdf',history:[]});
outgoingMail.send=async input=>{qa.sends++;qa.inputs.push(input);await new Promise(resolve=>setTimeout(resolve,150));if(qa.fail)throw new Error('La connexion a été interrompue. L’e-mail a peut-être été envoyé : vérifiez auprès du destinataire avant de préparer un nouvel envoi.');return{status:'accepted',replayed:false};};
function Preview(){const[open,setOpen]=useState(params.has('composer'));return <main className="desktop-app" data-experience="clarity" style={{display:'block',padding:'clamp(20px,5vw,64px)',maxWidth:1000,margin:'auto',minHeight:'100vh'}}><p style={{color:'var(--work-muted)',fontSize:13}}>Aperçu · entreprise et adresses fictives</p><MailSettings companyName="Atelier du Léman" companyEmail="contact@example.invalid"/><div style={{marginTop:32}}><Button onClick={()=>setOpen(true)}>Préparer un e-mail</Button></div>{open&&<MailComposer target={{entity:'invoices',id:'fixture-invoice'}} onClose={()=>setOpen(false)}/>}</main>}
createRoot(document.getElementById('root')!).render(<Preview/>);
