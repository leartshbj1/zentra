import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportFixture } from './export-test-fixture';
import { buildUsExportSnapshot, validateUsExportSnapshot, validateUsExportSelector } from './export-snapshot';
import { renderUsExportCsv, renderUsExportHtml, renderUsExportPdf } from './export-renderer';
import { exportCopy } from './export-copy';
import { browserExportUrl } from './browser-export-session';

const org = 'fictitious-export-company', seller = { organizationId: org, displayName: 'Fictitious current seller' }, selector = { kind: 'document', documentType: 'project', id: 'project 1 é' } as const;
const fonts = { regular: new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Regular.ttf'))), bold: new Uint8Array(readFileSync(resolve('public/fonts/us-exports/NotoSans-Bold.ttf'))) };
async function snapshot(language: 'fr'|'de'|'it'|'en' = 'en', basis: 'cash'|'accrual' = 'accrual') { return buildUsExportSnapshot(await exportFixture(basis, 'Project notes\nWith real line breaks', 'Fictitious TEST service', '12345', true), seller, selector, language); }
describe('dossier derived from the single recorded ERP', () => {
  it.each(['cash','accrual'] as const)('separates quote, invoiced, received and purchased amounts in %s', async basis => {
    const source = await exportFixture(basis,'Project notes','Fictitious TEST service','12345',true), before = JSON.stringify(source), s = buildUsExportSnapshot(source,seller,selector);
    expect(s.erpRevision).toBe(11); expect(s.recordRevision).toBe(2); expect(s.number).toBe('PRJ-000001'); expect(s.rows).toHaveLength(3);
    expect(s.totals).toEqual([{ label:'estimatesNet',minorUnits:'24690' },{label:'invoicedNet',minorUnits:'24690'},{label:'invoicedTax',minorUnits:'825'},{label:'invoicedTotal',minorUnits:'25515'},{label:'received',minorUnits:'10000'},{label:'outstanding',minorUnits:'15515'},{label:'purchasesNet',minorUnits:'10000'},{label:'purchasesTax',minorUnits:'825'},{label:'purchasesTotal',minorUnits:'10825'},{label:'purchasesBalance',minorUnits:'5825'}]);
    expect(s.recipient?.name).toBe('Actual customer example'); expect(JSON.stringify(s)).not.toMatch(/ein|taxAssessment|private-fictitious|actual-fixture-accountant|fingerprint|approvedAt|recordedBy|userId/); expect(JSON.stringify(source)).toBe(before);
  });
  it.each(['fr','de','it','en'] as const)('exports %s readable dossier HTML/CSV/PDF from actual runtime links', async language => {
    const s = await snapshot(language); expect(validateUsExportSnapshot(s)).toEqual(s);
    const html = renderUsExportHtml(s), csv = renderUsExportCsv(s), pdf = await renderUsExportPdf(s, fonts);
    expect(html).toContain(exportCopy[language].project); expect(html).toContain(exportCopy[language].projectNotice); expect(html).toContain('Project notes\nWith real line breaks'); expect(csv).toContain('"255.15"'); expect(csv).toContain('"155.15"');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(0); expect(pdf.byteLength).toBeLessThan(12*1024*1024);
    const directory = resolve('.qa/us-projects'); mkdirSync(directory,{recursive:true}); writeFileSync(resolve(directory,`project-${language}.pdf`),pdf);
    const inspected = JSON.parse(execFileSync('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',['-X','utf8','-c',"import sys,io,json,pdfplumber\nfrom pypdf import PdfReader\ndata=sys.stdin.buffer.read(); r=PdfReader(io.BytesIO(data)); bad=[]\nwith pdfplumber.open(io.BytesIO(data)) as p:\n for n,page in enumerate(p.pages):\n  for c in page.chars:\n   if c['text'].strip() and (c['x0']<41.5 or c['x1']>570.5 or c['top']<41 or c['bottom']>776): bad.append([n,c['text']])\nprint(json.dumps({'text':'\\n'.join(p.extract_text() for p in r.pages),'outside':bad,'sizes':[[float(p.mediabox.width),float(p.mediabox.height)] for p in r.pages]},ensure_ascii=False))"],{input:pdf,encoding:'utf8',maxBuffer:1024*1024,timeout:10000}));
    expect(inspected.outside).toEqual([]); expect(inspected.sizes.every((size:number[])=>size[0]===612&&size[1]===792)).toBe(true); expect(inspected.text).toContain(exportCopy[language].project); expect(inspected.text).toContain('PRJ-000001'); expect(inspected.text).toContain('With real line breaks');
  },20000);
  it('does not manufacture a dossier for an old book or an absent project', async () => {
    const state = await exportFixture(); expect(() => buildUsExportSnapshot(state,seller,selector)).toThrow('export_source_not_found');
  });
  it('paginates maximum-length valid party text without dropping or drawing outside the page',async()=>{
    const s=await snapshot(), party={name:'Ǆ'.repeat(256),address:{country:'US' as const,line1:'Ǆ'.repeat(200),line2:'Ǆ'.repeat(200),city:'Ǆ'.repeat(120),subdivision:'NY',postalCode:'10001'},contactEmail:'Ǆ'.repeat(100)+'@'+'Ǆ'.repeat(100)+'.test',contactPhone:'Ǆ'.repeat(80)};
    const valid=validateUsExportSnapshot({...s,seller:party,recipient:party}),pdf=await renderUsExportPdf(valid,fonts);
    const result=JSON.parse(execFileSync('C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',['-X','utf8','-c',"import sys,io,json,pdfplumber\nfrom pypdf import PdfReader\ndata=sys.stdin.buffer.read(); bad=[]\nwith pdfplumber.open(io.BytesIO(data)) as pdf:\n for n,p in enumerate(pdf.pages):\n  for c in p.chars:\n   if c['text'].strip() and (c['x0']<41.5 or c['x1']>570.5 or c['top']<41 or c['bottom']>776): bad.append([n,c['text'],c['bottom']])\nr=PdfReader(io.BytesIO(data)); print(json.dumps({'outside':bad,'text':'\\n'.join(p.extract_text() for p in r.pages),'pages':len(r.pages)},ensure_ascii=False))"],{input:pdf,encoding:'utf8',maxBuffer:1024*1024,timeout:10000}));
    expect(result.outside).toEqual([]); expect(result.pages).toBeGreaterThan(1); expect((result.text.match(/Ǆ/g)||[]).length).toBe(2*(256+200+200+120+200+80)); expect(result.text).toContain('With real line breaks');
  },20000);
  it('supports an empty project, optional planning and archived history without fake documents', async () => {
    const state = await exportFixture('accrual','','Fictitious TEST service','12345',true), project = state.projects![0];
    const empty = { ...state, projects:[...state.projects!,{...project,id:'empty-project',number:'PRJ-000002',revision:1,budget:null,startDate:null,targetDate:null,vendorBillIds:[],status:'archived' as const}], counters:{...state.counters,project:2} };
    const s = buildUsExportSnapshot(empty,seller,{...selector,id:'empty-project'},'fr'); expect(s.rows).toEqual([]); expect(s.totals.every(t=>t.minorUnits==='0')).toBe(true); expect(s.facts).toContainEqual({label:'budgetNet',value:exportCopy.fr.notSet}); expect(s.facts).toContainEqual({label:'projectStatus',value:exportCopy.fr.archived}); expect(s.facts.some(f=>f.label==='startDate')).toBe(false);
    const archived = buildUsExportSnapshot({...state,projects:[{...project,status:'archived'}]},seller,selector); expect(archived.rows).toHaveLength(3);
  });
  it.each(['estimatesNet','invoicedNet','invoicedTax','invoicedTotal','received','outstanding','purchasesNet','purchasesTax','purchasesTotal','purchasesBalance'])('recomputes %s rather than trusting it', async label => {
    const s = await snapshot(); expect(() => validateUsExportSnapshot({...s,totals:s.totals.map(t=>t.label===label?{...t,minorUnits:(BigInt(t.minorUnits)+BigInt(1)).toString()}:t)})).toThrow('invalid_export_snapshot');
  });
  it('rejects row category, monetary identity, quote tax, balance, column or status injection', async () => {
    const s = await snapshot();
    for (const [index,cell,value] of [[0,0,'credit_memo'],[0,4,'1'],[0,6,'1'],[1,5,'25516'],[1,6,'999999'],[1,3,'-1']] as const) {
      const rows=s.rows.map(row=>[...row]); rows[index][cell]=value; expect(()=>validateUsExportSnapshot({...s,rows})).toThrow('invalid_export_snapshot');
    }
    expect(()=>validateUsExportSnapshot({...s,columns:s.columns.filter(c=>c.label!=='tax')})).toThrow('invalid_export_snapshot');
    expect(()=>validateUsExportSnapshot({...s,facts:s.facts.map(f=>f.label==='projectStatus'?{...f,value:'deleted'}:f)})).toThrow('invalid_export_snapshot');
    expect(()=>validateUsExportSnapshot({...s,recordRevision:null})).toThrow('invalid_export_snapshot');
  });
  it('uses the existing scoped export URL with encoded IDs, no private credentials', () => {
    expect(validateUsExportSelector(selector)).toEqual(selector); expect(browserExportUrl(org,selector,'de','pdf')).toBe(`/api/international/workspaces/${org}/exports/documents/project/project%201%20%C3%A9?format=pdf&language=de`);
    expect(()=>validateUsExportSelector({...selector,role:'owner'})).toThrow('invalid_export_selector');
  });
});
