import {beforeEach,afterEach,expect,it,vi} from 'vitest';
vi.mock('./bridge',()=>({desktopApi:{loadWorkspace:vi.fn()}}));
vi.mock('./language',()=>({t:(value:string)=>value,getAppLocale:()=> 'fr-CH'}));
vi.mock('./ui',()=>({Button:()=>null}));
vi.mock('./ErrorGuidance',()=>({ErrorGuidance:()=>null}));
vi.mock('react-dom',()=>({flushSync:(run:()=>void)=>run()}));
beforeEach(()=>{vi.resetModules();vi.stubGlobal('window',{dispatchEvent:vi.fn()});});
afterEach(()=>vi.unstubAllGlobals());
it('records state transitions only and excludes company identifiers, payment and conflict details',async()=>{
  const s=await import('./companySync'),d=await import('./diagnostics');
  const state={enabled:true,revision:4,pending:true,conflict:false,organizationId:'org-secret-customer'};
  s.publishCompanySync(state);const count=d.recentDiagnosticEvents().length;
  s.publishCompanySync(state);expect(d.recentDiagnosticEvents()).toHaveLength(count);
  s.publishCompanySync({...state,conflict:true,conflictReason:'invoice private',duplicateReceipt:{localId:'id',remoteId:'id',invoiceId:'id',invoiceNumber:'private reference',amountCents:123456,currency:'CHF',date:'2026-01-01',fingerprint:'private'}});
  expect(d.recentDiagnosticEvents().at(-1)).toMatchObject({operation:'company.conflict',phase:'failure',errorCode:'CONFLICT'});
  expect(JSON.stringify(d.recentDiagnosticEvents())).not.toMatch(/org-secret|invoice private|private reference|123456|fingerprint/);
});
it('does not report successful reception after the native application failed',async()=>{
  const s=await import('./companySync'),d=await import('./diagnostics');
  s.setCompanyReceiving(true);s.recordCompanyReceiveFailure(new Error('database is locked'));s.setCompanyReceiving(false);
  const events=d.recentDiagnosticEvents();expect(events.map(event=>event.phase)).toEqual(['start','failure']);expect(events[0].id).toBe(events[1].id);
  s.setCompanyReceiving(true);s.setCompanyReceiving(false);expect(d.recentDiagnosticEvents().at(-1)?.phase).toBe('success');
});
