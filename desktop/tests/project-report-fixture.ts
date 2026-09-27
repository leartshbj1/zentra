import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
import type { ProjectReport } from '../src/projectReport';

export function installProjectReportFixture(w:Workspace) {
  const query=new URLSearchParams(location.search);
  const template=w.projects[0];
  const sampleInvoice=w.invoices[0];
  const single={...template,id:'report-single',clientId:w.clients[0].id,name:'Rénovation Bellevue — dossier de suivi et de livraison',notes:'NOTE INTERNE CONFIDENTIELLE',status:'in_progress' as const};
  w.projects=query.get('reportTest')==='empty' ? [] : query.get('reportTest')==='many' ? Array.from({length:25},(_,i)=>({...single,id:`report-${i}`,name:`Projet ${String(i+1).padStart(2,'0')}`})) : [single];
  w.invoices=w.projects.flatMap((project,i)=>[
    {...sampleInvoice,id:`report-issued-${i}`,projectId:project.id,number:`F-REPORT-${i}`,status:'issued' as const,createdAt:`2026-09-${String(i+1).padStart(2,'0')}T10:00:00Z`},
    {...sampleInvoice,id:`report-draft-${i}`,projectId:project.id,number:`SECRET-DRAFT-${i}`,status:'draft' as const},
  ]);
  w.quotes=[];w.payments=[];w.projectMilestones=[];w.projectTasks=[];w.timeEntries=[];w.expenses=[];w.supplierInvoices=[];w.supplierCreditNotes=[];w.agendaEvents=[];w.attachments=[];
  const qa={reports:[] as ProjectReport[],fail:false,cancel:false,pending:false,release:()=>{}};
  (window as unknown as {__projectReportsQa:typeof qa}).__projectReportsQa=qa;
  desktopApi.exportProjectReportPdf=async report=>{
    qa.reports.push(structuredClone(report));
    if(qa.pending)await new Promise<void>(resolve=>{qa.release=resolve;});
    if(qa.cancel)return null;
    if(qa.fail){qa.fail=false;throw new Error('Export du rapport impossible.');}
    return {path:'C:/Zentra-QA/rapport.pdf',pages:4};
  };
}
