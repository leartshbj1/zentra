import './languageTestPacks';
import { it, expect, afterEach } from 'vitest';
import { turnoverByCurrency } from './salesFinancials';
import { buildProjectReport, recentReportProjects, reportPresets, reportSections } from './projectReport';
import { setAppLanguage } from './language';
import { formatMoney } from './utils';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  for(const privateText of ['SECRET','Employé privé','F-DRAFT','F-CANCELLED','D-DRAFT','OTHER','Main-d’œuvre','Marge sur coûts enregistrés','Marge estimée','Budget'])expect(text).not.toContain(privateText);
  for(const publicText of ['F-PUBLIC','D-PUBLIC','Réception','Client SA','Camille Martin','27.09.2026'])expect(text).toContain(publicText);
  expect(result.sections.find(s=>s.title==='Situation financière')?.rows[0][1]).toContain('1');
});
it('retains the full internal report and explains that missing costs are not estimated',()=>{
  const {w,p}=reportFixture();
  const result=buildProjectReport(w,p,[...reportPresets.internal.sections] as (keyof typeof reportSections)[],{preset:'internal'});
  const text=JSON.stringify(result);
  for(const value of ['SECRET NOTE','SECRET HOURS','SECRET MILESTONE','SECRET TASK','SECRET FILE','F-DRAFT','F-CANCELLED','Marge sur coûts enregistrés','sans estimation des coûts manquants'])expect(text).toContain(value);
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
  expect(result.sections.find(section=>section.title==='Project notes')?.rows[0][0]).toBe('SECRET NOTE');
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
    expect(result.sections.some(section=>section.rows[0][0]==='SECRET NOTE')).toBe(true);
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
    'Repères du rapport',
  ]);
  expect(JSON.stringify(report)).not.toContain('9000');
  expect(report.sections.find(section=>section.title==='Notes du projet')?.rows[0][0]).toBe(p.notes);
});
it('states the real reporting scope, missing author and dates without inventing a period or identity',()=>{
  const {w,p}=reportFixture();
  const report=buildProjectReport(w,p,['overview','documents'],{preset:'summary',createdAt:new Date('2026-10-04T12:00:00Z')});
  const context=report.sections.find(section=>section.title==='Repères du rapport')!;
  expect(report.subtitle).toContain('Toute la durée du projet (aucun filtre de date)');
  expect(report.subtitle).toContain('Préparé par Non renseigné');
  expect(context.rows).toContainEqual(['Auteur','Non renseigné']);
  expect(context.rows).toContainEqual(['Début réel','Non renseigné']);
  expect(context.rows).toContainEqual(['Fin réelle','Non renseignée']);
  expect(context.rows).toContainEqual(['Rubriques incluses','Vue d’ensemble · Documents et notes']);
  expect(context.rows.find(row=>row[0]==='Informations manquantes ou rubriques vides')?.[1]).toContain('Auteur');
  expect(context.rows).toContainEqual(['Pièces jointes','Inventaire des fichiers uniquement, contenu non incorporé.']);
  expect(JSON.stringify(context)).not.toContain('2026-09-20');
});
it('shows recorded margin separately from an unavailable forecast, without turning a budget into estimated cost',()=>{
  const {w,p}=reportFixture();
  const report=buildProjectReport(w,p,['overview'],{preset:'summary'});
  const finance=report.sections.find(section=>section.title==='Situation financière')!;
  expect(finance.rows).toContainEqual(['Marge sur coûts enregistrés',formatMoney(100000-24690)]);
  expect(finance.rows).toContainEqual(['Marge estimée','Non calculée : coûts prévisionnels complets non disponibles.']);
  expect(report.sections.find(section=>section.title==='Repères du rapport')?.rows).toContainEqual(['Limite des montants','Les coûts non enregistrés sont inconnus. La marge sur coûts enregistrés ne constitue pas une marge finale ni une prévision.']);
});
it('keeps missing conversion and empty-section information explicit instead of reporting a computed margin',()=>{
  const {w,p}=reportFixture();w.invoices=[invoice('EUR',100000,{currency:'EUR'})];w.attachments=[];
  const report=buildProjectReport(w,p,['overview','documents'],{preset:'internal',author:'  Camille Martin  '});
  expect(report.sections.find(section=>section.title==='Situation financière')?.rows).toContainEqual(['Marge sur coûts enregistrés','Conversion CHF requise']);
  const context=report.sections.find(section=>section.title==='Repères du rapport')!;
  expect(context.rows).toContainEqual(['Auteur','Camille Martin']);
  const missing=context.rows.find(row=>row[0]==='Informations manquantes ou rubriques vides')?.[1];
  expect(missing).toContain('Documents du projet');expect(missing).not.toContain('Auteur');
});
it.each(['de','it','en'] as const)('translates provenance and estimated-margin explanations in %s',async language=>{
  const {w,p}=reportFixture();await setAppLanguage(language);
  const report=buildProjectReport(w,p,['overview'],{preset:'summary'}),text=JSON.stringify(report);
  for(const french of ['Repères du rapport','Période exportée','Rubriques incluses','Informations manquantes ou rubriques vides','Marge estimée','Non calculée : coûts prévisionnels complets non disponibles.'])expect(text).not.toContain(french);
  expect(report.title).toBe(p.name);
});
it('preserves long project rows and the exact existing native payload shape for every composition',async()=>{
  const {w,p}=reportFixture();
  const first=invoice('F-LONG',100000);
  first.lines=Array.from({length:120},(_,index)=>({...first.lines[0],id:`line-${index}`,description:`PUBLIC LINE ${String(index).padStart(3,'0')} - Étude et réalisation avec suivi détaillé du projet.\nCoordination et réception.`,unitPriceCents:1000}));
  w.invoices.push(first);
  const proofDirectory=process.env.ZENTRA_PROJECT_REPORT_PROOF_DIR;
  for(const language of ['fr','de','it','en'] as const) {
    await setAppLanguage(language);
    for(const preset of ['summary','client','internal'] as const) {
      const selected=[...reportPresets[preset].sections] as (keyof typeof reportSections)[];
      const report=buildProjectReport(w,p,selected,{preset,author:'Camille Martin',createdAt:new Date('2026-10-04T12:00:00Z')});
      expect(Object.keys(report).sort()).toEqual(['language','sections','subtitle','title']);
      for(const section of report.sections) {
        expect(Object.keys(section).sort()).toEqual(['headers','rows','title']);expect(section.headers.length).toBeGreaterThan(0);expect(section.headers.length).toBeLessThanOrEqual(4);
        for(const row of section.rows)expect(row).toHaveLength(section.headers.length);
      }
      const serialized=JSON.stringify(report);
      if(preset==='client')expect(serialized).not.toContain('SECRET');
      if(preset!=='summary') {
        const lines=report.sections.find(section=>section.rows[0][0].startsWith('PUBLIC LINE 000'))!.rows;
        expect(lines).toHaveLength(120);expect(lines[119][0]).toContain('PUBLIC LINE 119');
      }
      if(proofDirectory) {mkdirSync(proofDirectory,{recursive:true});writeFileSync(join(proofDirectory,`${preset}-${language}.json`),JSON.stringify(report,null,2)+'\n');}
    }
  }
});
