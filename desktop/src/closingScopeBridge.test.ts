import {beforeEach,describe,expect,it,vi} from 'vitest';
const {invokeMock,shareMock}=vi.hoisted(()=>({invokeMock:vi.fn(),shareMock:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:invokeMock}));
vi.mock('./mobileRuntime',()=>({isMobileRuntime:()=>true,shareMobileExport:shareMock,materializeMobileFile:vi.fn()}));
import {desktopApi} from './bridge';
import {recentDiagnosticEvents,resolveErrorIncident} from './diagnostics';
const filter={dateFrom:'2026-01-01',dateTo:'2026-12-31'};
const period={id:'period-1',name:'Exercice fictif',date_from:filter.dateFrom,date_to:filter.dateTo,status:'open'};
const review={review_id:'review-1',period,source_sha256:'a'.repeat(64),checks:{},summary:{}};
const finalized={review_id:'review-1',source_sha256:'a'.repeat(64),period:{...period,status:'closed'}};
const exported={export_id:'export-1',review_id:'review-1',period,package_status:'DRAFT',source_sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64),file_name:'Fictif.zip',path:'/SYNTHETIC-PRIVATE/closing.zip',file_count:1};
const pdf={path:'/SYNTHETIC-PRIVATE/annual.pdf',pages:2,closed:false,balanced:true};
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
const methods=[
  {command:'prepare_fiduciary_pre_closing',run:(scope?:string)=>desktopApi.prepareFiduciaryPreClosing(filter,scope),args:{filter:{date_from:filter.dateFrom,date_to:filter.dateTo}}},
  {command:'finalize_accounting_period_with_review',run:(scope?:string)=>desktopApi.finalizeAccountingPeriodWithReview('period-1','review-1',scope),args:{periodId:'period-1',reviewId:'review-1'}},
  {command:'export_fiduciary_closing_zip',run:(scope?:string)=>desktopApi.exportFiduciaryClosingZip('review-1',scope),args:{reviewId:'review-1'}},
  {command:'export_annual_accounts_pdf',run:(scope?:string)=>desktopApi.exportAnnualAccountsPdf(filter,scope),args:{filter:{date_from:filter.dateFrom,date_to:filter.dateTo},destinationPath:pdf.path}},
];
describe('closing exports bind admission to the origin without replay',()=>{
  beforeEach(()=>{
    invokeMock.mockReset();shareMock.mockReset();shareMock.mockResolvedValue(undefined);
    invokeMock.mockImplementation(async(command:string)=>{
      if(command==='prepare_mobile_export')return pdf.path;
      if(command==='prepare_fiduciary_pre_closing')return review;
      if(command==='finalize_accounting_period_with_review')return finalized;
      if(command==='export_fiduciary_closing_zip')return exported;
      if(command==='export_annual_accounts_pdf')return pdf;
      throw Error('Unexpected synthetic command');
    });
  });
  for(const method of methods){
    it(`${method.command} keeps its exact legacy None payload`,async()=>{
      await method.run();const calls=invokeMock.mock.calls.filter(([command])=>command===method.command);
      expect(calls).toEqual([[method.command,method.args]]);
    });
    it(`${method.command} forwards the origin scope only at IPC top level`,async()=>{
      await method.run('SYNTHETIC-PRIVATE-SCOPE-A');const calls=invokeMock.mock.calls.filter(([command])=>command===method.command);
      expect(calls).toEqual([[method.command,{...method.args,expectedWorkspaceScope:'SYNTHETIC-PRIVATE-SCOPE-A'}]]);
    });
  }
  for(const kind of ['zip','annual'] as const){
    it(`${kind} rejects an obsolete origin before any picker, export or share`,async()=>{
      const task=kind==='zip'?desktopApi.exportFiduciaryClosingZip('review-1','scope-a',()=>false):desktopApi.exportAnnualAccountsPdf(filter,'scope-a',()=>false);
      await expect(task).rejects.toThrow('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');
      expect(invokeMock).not.toHaveBeenCalled();expect(shareMock).not.toHaveBeenCalled();
    });
    it(`${kind} retains the acquired file and never shares or recreates it after departure`,async()=>{
      const held=deferred<typeof exported|typeof pdf>();let current=true;
      const command=kind==='zip'?'export_fiduciary_closing_zip':'export_annual_accounts_pdf';
      invokeMock.mockImplementation(async(name:string)=>name==='prepare_mobile_export'?pdf.path:held.promise);
      const task=kind==='zip'?desktopApi.exportFiduciaryClosingZip('review-1','scope-a',()=>current):desktopApi.exportAnnualAccountsPdf(filter,'scope-a',()=>current);
      await vi.waitFor(()=>expect(invokeMock.mock.calls.filter(([name])=>name===command)).toHaveLength(1));
      current=false;held.resolve(kind==='zip'?exported:pdf);const result=await task;
      expect(result).toMatchObject(kind==='zip'?{exportId:'export-1',path:exported.path}:pdf);
      expect(result).not.toHaveProperty('deliveryWarning');expect(shareMock).not.toHaveBeenCalled();
      expect(invokeMock.mock.calls.filter(([name])=>name===command)).toHaveLength(1);
    });
    it(`${kind} keeps the exact native rejection and never shares`,async()=>{
      const reason={message:'SYNTHETIC-PRIVATE-REJECTION',secret:'synthetic-only'};
      invokeMock.mockImplementation(async(name:string)=>{if(name==='prepare_mobile_export')return pdf.path;throw reason;});
      const task=kind==='zip'?desktopApi.exportFiduciaryClosingZip('review-1','scope-a',()=>true):desktopApi.exportAnnualAccountsPdf(filter,'scope-a',()=>true);
      await expect(task).rejects.toBe(reason);expect(shareMock).not.toHaveBeenCalled();
    });
  }
  it('a picker settled after scope replacement refuses the export and logs a fixed incident without data',async()=>{
    const selected=deferred<string>();let current=true;const start=recentDiagnosticEvents().length;
    invokeMock.mockImplementation(()=>selected.promise);
    const task=desktopApi.exportAnnualAccountsPdf(filter,'SYNTHETIC-PRIVATE-SCOPE-A',()=>current);
    await vi.waitFor(()=>expect(invokeMock).toHaveBeenCalledTimes(1));current=false;selected.resolve(pdf.path);
    let reason:unknown;try{await task;}catch(error){reason=error;}
    expect(reason).toBeInstanceOf(Error);expect((reason as Error).message).toContain('L’entreprise ouverte a changé.');
    expect(invokeMock.mock.calls).toEqual([['prepare_mobile_export',{name:'Zentra-bilan-2026-12-31.pdf'}]]);expect(shareMock).not.toHaveBeenCalled();
    const events=recentDiagnosticEvents().slice(start).filter(event=>event.operation==='annual_accounts.export');
    expect(events).toHaveLength(2);expect(events.map(event=>event.phase)).toEqual(['start','failure']);expect(events[1].errorCode).toBe('CONFLICT');
    expect(resolveErrorIncident(reason).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toMatch(/SYNTHETIC-PRIVATE|2026-01-01|2026-12-31|annual\.pdf|date_from|Rouvrez/);
    for(const event of events)expect(Object.keys(event).sort()).toEqual((event.phase==='start'?['id','sessionId','timestamp','area','operation','phase']:['id','sessionId','timestamp','area','operation','phase','durationMs','errorCode']).sort());
  });
  it('cancelling the picker keeps null and does not export or share',async()=>{
    invokeMock.mockResolvedValue(null);expect(await desktopApi.exportAnnualAccountsPdf(filter,'scope-a',()=>true)).toBeNull();
    expect(invokeMock.mock.calls).toEqual([['prepare_mobile_export',{name:'Zentra-bilan-2026-12-31.pdf'}]]);expect(shareMock).not.toHaveBeenCalled();
  });
});
