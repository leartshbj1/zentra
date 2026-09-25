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
setAppearance(params.get('theme') === 'dark' ? 'dark' : 'light');
const sample={subject:'Votre facture {numero} — {entreprise}',body:'Bonjour {client},\n\nVous trouverez en pièce jointe notre facture {numero}, d’un montant de {montant}, payable jusqu’au {echeance}.\n\nNous vous remercions de votre confiance.\n\nAtelier du Léman\n{email_entreprise}'};
let state:MailState={scope:'fixture-company',connection:{connected:params.has('connected'),fromName:'Atelier du Léman',fromEmail:'contact@example.invalid',host:'mail.infomaniak.com',port:465,security:'tls',username:'contact@example.invalid'},templates:{quotes:{...sample,subject:'Votre devis {numero} — {entreprise}'},invoices:sample},canConfigure:true};
const qa={sends:0,connections:0,templates:0,fail:params.has('fail'),inputs:[] as unknown[]};
Object.assign(window,{__mailQa:qa});
outgoingMail.state=async()=>structuredClone(state);
outgoingMail.connect=async(_,connection)=>{qa.connections++;state={...state,connection:{...connection,connected:true}};return state.connection;};
outgoingMail.disconnect=async()=>{state={...state,connection:{connected:false}};};
outgoingMail.saveTemplates=async(_,templates)=>{qa.templates++;state={...state,templates};};
outgoingMail.preview=async target=>({scope:state.scope,target,sourceRevision:'revision-1',recipient:'client@example.invalid',subject:'Votre facture F-2026-0142 — Atelier du Léman',body:'Bonjour Camille,\n\nVous trouverez en pièce jointe notre facture F-2026-0142, d’un montant de 1’250.00 CHF, payable jusqu’au 30.10.2026.\n\nNous vous remercions de votre confiance.\n\nAtelier du Léman\ncontact@example.invalid',attachmentName:'Facture-F-2026-0142.pdf',history:[]});
outgoingMail.send=async input=>{qa.sends++;qa.inputs.push(input);await new Promise(resolve=>setTimeout(resolve,150));if(qa.fail)throw new Error('La connexion a été interrompue. L’e-mail a peut-être été envoyé : vérifiez auprès du destinataire avant de préparer un nouvel envoi.');return{status:'accepted',replayed:false};};
function Preview(){const[open,setOpen]=useState(params.has('composer'));return <main className="desktop-app" style={{display:'block',padding:'clamp(20px,5vw,64px)',maxWidth:1000,margin:'auto',minHeight:'100vh'}}><p style={{color:'var(--work-muted)',fontSize:13}}>Aperçu · entreprise et adresses fictives</p><MailSettings companyName="Atelier du Léman" companyEmail="contact@example.invalid"/><div style={{marginTop:32}}><Button onClick={()=>setOpen(true)}>Préparer un e-mail</Button></div>{open&&<MailComposer target={{entity:'invoices',id:'fixture-invoice'}} onClose={()=>setOpen(false)}/>}</main>}
createRoot(document.getElementById('root')!).render(<Preview/>);
