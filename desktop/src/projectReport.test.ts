import './languageTestPacks';
import { it, expect, afterEach } from 'vitest';
import { turnoverByCurrency } from './salesFinancials';
import { buildProjectReport, recentReportProjects, reportPresets, reportSections } from './projectReport';
import { setAppLanguage } from './language';
import type { Invoice, Workspace, Project } from './types';
const invoice = (
  id: string,
  amount: number,
  extra: Partial<Invoice> = {},
): Invoice =>
  ({
    id,
    number: id,
    title: 'Travaux',
    status: 'issued',
    currency: 'CHF',
    issueDate: '2026-09-01',
    projectId: 'p',
    type: 'standard',
    lines: [
      {
        id: 'l',
        description: 'Prestation',
        quantity: 1,
        unit: 'h',
        unitPriceCents: amount,
        vatRateBp: 810,
      },
    ],
    ...extra,
  }) as Invoice;
it('shows annual net invoiced revenue with deposit deductions, credits and separate currencies', () => {
  const invoices = [
    invoice('acompte', 30000, { type: 'deposit' }),
    invoice('solde', 70000, { type: 'final' }),
    invoice('avoir', -10000, { type: 'credit_note' }),
    invoice('brouillon', 999999, { status: 'draft' }),
    invoice('annule', 999999, { status: 'cancelled' }),
    invoice('ancien', 999999, { issueDate: '2025-01-01' }),
    invoice('eur', 20000, { currency: 'EUR' }),
  ];
  expect(turnoverByCurrency(invoices, 2026)).toEqual([
    { currency: 'CHF', netCents: 90000 },
    { currency: 'EUR', netCents: 20000 },
  ]);
});

afterEach(async ()=>await setAppLanguage('fr'));
function reportFixture() {
  const p={id:'p',clientId:'c',name:'Rénovation Léman',status:'in_progress',budgetCents:876543,plannedMinutes:600,notes:'SECRET NOTE'} as Project;
  const w={projects:[p],clients:[{id:'c',name:'Camille',company:'Client SA'}],invoices:[invoice('F-PUBLIC',100000),invoice('F-DRAFT',50000,{status:'draft'}),invoice('F-CANCELLED',40000,{status:'cancelled'}),invoice('OTHER',999999,{projectId:'other'})],quotes:[{...invoice('D-DRAFT',99999),status:'draft'},{...invoice('D-PUBLIC',100000),status:'accepted'}],payments:[],supplierInvoices:[],supplierCreditNotes:[],expenses:[],employees:[{id:'e',name:'Employé privé'}],timeEntries:[{id:'t',projectId:'p',employeeId:'e',date:'2026-09-20',minutes:120,hourlyCostCents:12345,status:'approved',note:'SECRET HOURS'}],projectMilestones:[{id:'m',projectId:'p',title:'Réception',description:'SECRET MILESTONE',dueDate:'2026-10-01',status:'todo'}],projectTasks:[{id:'t',projectId:'p',title:'SECRET TASK',description:'À revoir',dueDate:'2026-09-30',status:'todo'}],agendaEvents:[{id:'a',projectId:'p',title:'SECRET MEETING'}],attachments:[{id:'a',projectId:'p',originalName:'SECRET FILE',mimeType:'application/pdf',createdAt:'2026-09-20'}]} as unknown as Workspace;
  return {w,p};
}
it('keeps internal costs, drafts, task notes and attachments out of the client report even if requested',()=>{
  const {w,p}=reportFixture();
  const result=buildProjectReport(w,p,Object.keys(reportSections) as (keyof typeof reportSections)[],{preset:'client',author:'Camille Martin',createdAt:new Date('2026-09-27T12:00:00Z')});
  const text=JSON.stringify(result);
  for(const privateText of ['SECRET','Employé privé','F-DRAFT','F-CANCELLED','D-DRAFT','OTHER','Main-d’œuvre','Marge de gestion','Budget'])expect(text).not.toContain(privateText);
  for(const publicText of ['F-PUBLIC','D-PUBLIC','Réception','Client SA','Camille Martin','27.09.2026'])expect(text).toContain(publicText);
  expect(result.sections.find(s=>s.title==='Situation financière')?.rows[0][1]).toContain('1');
});
it('retains the full internal report and explains that missing costs are not estimated',()=>{
  const {w,p}=reportFixture();
  const result=buildProjectReport(w,p,[...reportPresets.internal.sections] as (keyof typeof reportSections)[],{preset:'internal'});
  const text=JSON.stringify(result);
  for(const value of ['SECRET NOTE','SECRET HOURS','SECRET MILESTONE','SECRET TASK','SECRET FILE','F-DRAFT','F-CANCELLED','Marge de gestion','sans estimation des coûts manquants'])expect(text).toContain(value);
  expect(text).not.toContain('OTHER');
});
it('translates structural text while preserving project and client content',async ()=>{
  const {w,p}=reportFixture();await setAppLanguage('en');
  const result=buildProjectReport(w,p,['overview','documents'],{preset:'internal'});
  expect(result.language).toBe('en');
  expect(result.title).toBe('Rénovation Léman');
  expect(result.sections[0].title).toBe('The project');
  expect(result.sections[0].headers).toEqual(['Information','Detail']);
  expect(result.sections[0].rows).toContainEqual(['Client','Client SA']);
  expect(result.sections.at(-1)?.rows[0][0]).toBe('SECRET NOTE');
  expect(result.subtitle).toContain('Entire project duration');
});
it('uses translated empty rows so the PDF does not inject a French fallback',async ()=>{
  const {w,p}=reportFixture();w.attachments=[];await setAppLanguage('de');
  const result=buildProjectReport(w,p,['documents']);
  expect(result.language).toBe('de');
  expect(result.sections[0].rows[0][0]).not.toBe('Aucune donnée enregistrée');
  expect(result.sections[0].rows[0]).toHaveLength(3);
});
it('carries the selected language to the native exporter while retaining client content', async () => {
  const {w,p}=reportFixture();
  for (const language of ['fr','de','it','en'] as const) {
    await setAppLanguage(language);
    const result=buildProjectReport(w,p,['overview','documents']);
    expect(result.language).toBe(language);
    expect(result.title).toBe(p.name);
    expect(result.sections.at(-1)?.rows[0][0]).toBe('SECRET NOTE');
  }
});
it('orders projects by recorded activity, without modifying the workspace order or using future planned dates',()=>{
  const {w,p}=reportFixture();
  w.projects=[{...p,id:'old',name:'A',plannedStart:'2030-01-01'},{...p,id:'recent',name:'B'}];
  w.invoices=[invoice('old',1,{projectId:'old',createdAt:'2025-09-01'}),invoice('recent',1,{projectId:'recent',createdAt:'2026-09-01'})];
  w.projectTasks=[];w.projectMilestones=[];w.attachments=[];w.timeEntries=[];
  expect(recentReportProjects(w).map(p=>p.id)).toEqual(['recent','old']);
  expect(w.projects.map(p=>p.id)).toEqual(['old','recent']);
});
it('exports only the selected project and chosen sections, with credit-aware financial figures', () => {
  const p = {
    id: 'p',
    clientId: 'c',
    name: 'Projet A',
    status: 'in_progress',
    budgetCents: 100000,
    plannedMinutes: 600,
    notes: 'Conditions\nDeuxième ligne',
  } as Project;
  const w = {
    projects: [p],
    clients: [{ id: 'c', name: 'Client A' }],
    invoices: [
      invoice('A', 100000),
      invoice('B', 900000, { projectId: 'other' }),
    ],
    quotes: [],
    payments: [],
    timeEntries: [],
    expenses: [],
    supplierInvoices: [],
    supplierCreditNotes: [],
    projectMilestones: [],
    projectTasks: [],
    agendaEvents: [],
    attachments: [],
    employees: [],
  } as unknown as Workspace;
  const report = buildProjectReport(w, p, ['overview', 'documents']);
  expect(report.sections.map((s) => s.title)).toEqual([
    'Le projet',
    'Situation financière',
    'Documents du projet',
    'Notes du projet',
  ]);
  expect(JSON.stringify(report)).not.toContain('9000');
  expect(report.sections.at(-1)?.rows[0][0]).toBe(p.notes);
});
