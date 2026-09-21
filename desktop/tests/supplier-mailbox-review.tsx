// Synthetic QA only. No network, cloud account or real financial mutation.
import { useState } from 'react';
import {createRoot}from'react-dom/client';
import{SupplierInbox}from'../src/SupplierInboxPanel';
import{setAppearance}from'../src/appearance';
import{setAppLanguage}from'../src/language';
import type{Workspace}from'../src/types';
import type{MailInvoice,useSupplierInbox}from'../src/supplierInbox';
import'../src/styles.css';import'../src/workspace-design.css';import'../src/mobile.css';import'../src/dark.generated.css';import'../src/dark.css';
const item:MailInvoice={id:'00000000-0000-4000-8000-000000000001',organizationId:'qa-company',fileName:'facture-test.pdf',mediaType:'application/pdf',sha256:'qa',sender:'factures@exemple.test',subject:'Facture de fournitures',state:'ready',invoiceId:null,automatic:false,otherDevice:false,createdAt:1,extraction:{supplierName:'Atelier Demo Fournitures SA',reference:'ZT-QA-20260921-01',invoiceDate:'2026-09-21',dueDate:'2026-10-21',currency:'CHF',netCents:10000,vatCents:810,totalCents:10810,vatBp:810,category:'materials',confidence:.98,issues:[],evidence:{}}};
const workspace={suppliers:[{id:'qa-vendor',name:'Atelier Demo Fournitures SA',email:'factures@exemple.test',archivedAt:null}],supplierInvoices:[],accounts:[{id:'qa-expense',code:'4000',name:'Achats de marchandises',active:true,accountType:'expense'}]}as unknown as Workspace;
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(_command:string,args:{data?:{action?:string}})=>{if(args?.data?.action==='document'){const response=await fetch('/tests/fixtures/automation-test-invoice.pdf');if(!response.ok)throw Error('Missing QA PDF');const bytes=new Uint8Array(await response.arrayBuffer());return{base64:btoa(String.fromCharCode(...bytes))};}return{};}}});
function Preview(){const[result,setResult]=useState('');const[items,setItems]=useState([item]);
const inbox={state:{organizationId:'qa-company',linked:true,autoPost:false,automationActive:true,items},error:'',busy:false,refresh:async()=>{},importInvoice:async(_item:MailInvoice,_draft:unknown,confirm:boolean)=>{setResult(confirm?'Facture comptabilisée (essai local)':'Brouillon enregistré (essai local)');setItems([{...item,state:'imported',invoiceId:item.id}]);return{id:item.id,workspace,posted:confirm};}}as unknown as ReturnType<typeof useSupplierInbox>;
return <main className="desktop-app" data-experience="apple" style={{padding:16,maxWidth:1200,margin:'auto'}}><nav><button onClick={()=>setAppearance('light')}>Clair</button><button onClick={()=>setAppearance('dark')}>Sombre</button><button onClick={()=>setAppLanguage('de')}>Deutsch</button><button onClick={()=>setAppLanguage('fr')}>Français</button></nav><SupplierInbox inbox={inbox} workspace={workspace} readOnly={false} onOpen={()=>{}} onCreateSupplier={async()=>{setResult('Fournisseur ajouté (essai local)');return 'qa-vendor';}}/>{result&&<output>{result}</output>}</main>}
createRoot(document.getElementById('root')!).render(<Preview/>);
