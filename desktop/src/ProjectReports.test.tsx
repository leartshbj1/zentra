// @vitest-environment jsdom
import './languageTestPacks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReportsScreen } from './ProjectReports';
import { desktopApi } from './bridge';
import { setAppLanguage } from './language';
import type { Project, Workspace } from './types';

let root: Root, host: HTMLDivElement;
const onOpenProjects=vi.fn(),onOpenAccounting=vi.fn();
function workspace(count=1,scope='company-a'):Workspace {
  const projects=Array.from({length:count},(_,index)=>({id:`p-${index}`,clientId:'c',name:`Projet ${index+1}`,status:'in_progress',address:'Rue du Lac 1',actualStart:'2026-09-01',actualEnd:'',plannedStart:'',plannedEnd:'',budgetCents:100000,plannedMinutes:60,notes:'PRIVATE NOTES'}) as Project);
  return {workNotesScope:scope,projects,clients:[{id:'c',name:'Client'}],invoices:[],quotes:[],payments:[],employees:[],timeEntries:[],expenses:[],supplierInvoices:[],supplierCreditNotes:[],projectMilestones:[],projectTasks:[],agendaEvents:[],attachments:[],timeBillingBatches:[],timeBillingEntries:[]} as unknown as Workspace;
}
async function render(w:Workspace) {await act(async()=>root.render(<ReportsScreen workspace={w} onOpenAccounting={onOpenAccounting} onOpenProjects={onOpenProjects}/>));}
const exportButton=()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Exporter le PDF')!;
async function selectPreset(value:string) {const select=host.querySelector<HTMLSelectElement>('[aria-label="Type de rapport"]')!;await act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});onOpenProjects.mockReset();onOpenAccounting.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();await setAppLanguage('fr');});

it('opens the unique project with its useful summary before export configuration',async()=>{
  const exportPdf=vi.spyOn(desktopApi,'exportProjectReportPdf').mockResolvedValue(null);
  await render(workspace());
  expect(host.querySelector('h2')?.textContent).toBe('Projet 1');
  const summary=host.querySelector('.project-reports__figures')!,configuration=host.querySelector('.project-reports__configuration')!;
  expect(summary.compareDocumentPosition(configuration)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(summary.textContent).toContain('Marge sur coûts enregistrés');expect(host.textContent).toContain('Marge estimée');
  expect(exportButton().disabled).toBe(false);expect(exportPdf).not.toHaveBeenCalled();
});
it('offers recent project choices without auto-selecting another project when several exist',async()=>{
  const w=workspace(4);w.timeEntries=[{projectId:'p-3',date:'2026-10-04',minutes:10,hourlyCostCents:0}] as Workspace['timeEntries'];
  await render(w);
  const recent=host.querySelector('.project-reports__recent')!;
  expect(Array.from(recent.querySelectorAll('button')).map(button=>button.textContent)).toEqual(['Projet 4','Projet 1','Projet 2']);
  expect(host.querySelector('.project-reports__figures')).toBeNull();
  await act(async()=>recent.querySelector('button')!.click());
  expect(host.querySelector('h2')?.textContent).toBe('Projet 4');expect(host.querySelector('.project-reports__figures')).not.toBeNull();
});
it('exports client-safe provenance using the existing API and workspace guard',async()=>{
  const exportPdf=vi.spyOn(desktopApi,'exportProjectReportPdf').mockResolvedValue(null);
  const w=workspace();await render(w);await selectPreset('client');await act(async()=>exportButton().click());
  expect(exportPdf).toHaveBeenCalledTimes(1);
  const [report,scope,isCurrent]=exportPdf.mock.calls[0];
  expect(scope).toBe('company-a');expect(isCurrent?.()).toBe(true);
  const text=JSON.stringify(report);expect(text).toContain('Repères du rapport');expect(text).toContain('Préparé par Non renseigné');
  for(const privateValue of ['PRIVATE NOTES','Marge sur coûts enregistrés','Marge estimée'])expect(text).not.toContain(privateValue);
  expect(host.querySelector('.project-reports__figures')?.textContent).not.toContain('Coûts enregistrés');
});
it('prevents empty-content exports and preserves the route to create a first project',async()=>{
  const exportPdf=vi.spyOn(desktopApi,'exportProjectReportPdf').mockResolvedValue(null);await render(workspace());
  await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(exportButton().disabled).toBe(true);expect(host.textContent).toContain('Choisissez au moins une rubrique');expect(exportPdf).not.toHaveBeenCalled();
  await render(workspace(0));const firstProject=Array.from(host.querySelectorAll('button')).find(button=>button.textContent?.trim()==='Voir les projets')!;
  await act(async()=>firstProject.click());expect(onOpenProjects).toHaveBeenCalledTimes(1);
});
it('ignores completion from a previous company even if its project ID is reused',async()=>{
  let finish:(value:{path:string;pages:number})=>void=()=>{};
  const exportPdf=vi.spyOn(desktopApi,'exportProjectReportPdf').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await render(workspace());await act(async()=>exportButton().click());const oldGuard=exportPdf.mock.calls[0][2]!;
  await render(workspace(1,'company-b'));expect(oldGuard()).toBe(false);
  await act(async()=>finish({path:'PRIVATE-OLD-COMPANY.pdf',pages:1}));
  expect(host.textContent).not.toContain('PRIVATE-OLD-COMPANY.pdf');expect(exportButton().disabled).toBe(false);
});
