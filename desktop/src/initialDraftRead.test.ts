import {describe,expect,it} from 'vitest';
import {FormDraftSession,FORM_DRAFT_COMPLETED_PREFIX,FORM_DRAFT_PREFIX,formDraftFingerprint,formDraftKey,type DraftStorage,type FormDraftScope} from './formDrafts';
import {recentDiagnosticEvents} from './diagnostics';

const oldId='11111111-1111-4111-8111-111111111111',freshId='22222222-2222-4222-8222-222222222222',now=Date.now();
const fresh={creationId:freshId,text:'New visible entry'},retained={creationId:oldId,text:'Retained previous entry'};
class FaultStorage implements DraftStorage {
  rows=new Map<string,string>();denied=new Set<string>();writes:string[]=[];removes:string[]=[];changedPair=false;private reads=0;
  get length(){return this.rows.size;}key(index:number){return [...this.rows.keys()][index]??null;}
  getItem(key:string){if(this.denied.has(key))throw Error('Storage read denied');if(key.startsWith(FORM_DRAFT_PREFIX)){this.reads++;if(this.changedPair&&this.reads%2===0)return 'different retained record';}return this.rows.get(key)??null;}
  setItem(key:string,value:string){this.writes.push(key);this.rows.set(key,value);}removeItem(key:string){this.removes.push(key);this.rows.delete(key);}
}
const valid=(value:unknown):value is typeof fresh=>!!value&&typeof value==='object'&&typeof (value as any).text==='string'&&typeof (value as any).creationId==='string';
function fixture(type='clients',rawKind:'draft'|'invalid'|'ack'='draft'){
  const storage=new FaultStorage(),scope:FormDraftScope={companyId:'synthetic-initial-read-company',memberId:'synthetic-local-member',type};
  const key=formDraftKey(scope),marker=key.replace(FORM_DRAFT_PREFIX,FORM_DRAFT_COMPLETED_PREFIX);
  const raw=rawKind==='invalid'?'invalid retained text':JSON.stringify({version:1,scope:key,fingerprint:'new',savedAt:now,value:retained});storage.rows.set(key,raw);
  if(rawKind==='ack')storage.rows.set(marker,JSON.stringify({version:1,savedAt:now,recordFingerprint:formDraftFingerprint(raw)}));
  const create=()=>new FormDraftSession({scope,initial:fresh,fingerprint:'new',validate:valid,storage:()=>storage,now:()=>now});
  return {storage,key,marker,raw,create};
}
describe('initial read barrier on the real local draft core',()=>{
  for(const type of ['clients','suppliers','employees','time_entries'])for(const fault of ['draft','marker'])for(const recovery of ['before-capture','still-unavailable'])
    it(`preserves previous UUID and text for ${type}/${fault}/${recovery}`,()=>{
      const f=fixture(type);f.storage.denied.add(fault==='draft'?f.key:f.marker);const session=f.create();
      expect(session.getSnapshot().storageError).toBe(true);expect(session.getSnapshot().pending).toBeNull();
      if(recovery==='before-capture')f.storage.denied.clear();session.capture({...fresh,text:'Latest final keystroke'});
      expect(f.storage.rows.get(f.key)).toBe(f.raw);expect(f.storage.writes).toEqual([]);expect(f.storage.removes).toEqual([]);
      expect(session.getSnapshot().value).toEqual({...fresh,text:'Latest final keystroke'});
      if(recovery==='still-unavailable'){expect(session.getSnapshot().storageError).toBe(true);f.storage.denied.clear();session.retryStorage();}
      expect(session.getSnapshot().pending?.value).toEqual(retained);expect(session.getSnapshot().initialReadState).toBe('decision');
      session.capture({...fresh,text:'Another custom final capture'});session.retryStorage();session.keepLocal();
      expect(f.storage.rows.get(f.key)).toBe(f.raw);expect(f.storage.writes).toEqual([]);
      session.restore();expect(session.getSnapshot().value).toEqual(retained);expect(session.getSnapshot().initialReadState).toBe('ready');
      session.capture({...retained,text:'Explicitly restored and edited'});expect(JSON.parse(f.storage.rows.get(f.key)!).value.creationId).toBe(oldId);
    });
  it.each(['draft','marker'])('does not complete or delete an unknown initial %s',fault=>{
    const f=fixture();f.storage.denied.add(fault==='draft'?f.key:f.marker);const session=f.create();session.complete(true);
    expect(f.storage.rows.get(f.key)).toBe(f.raw);expect(f.storage.writes).toEqual([]);expect(f.storage.removes).toEqual([]);expect(session.getSnapshot().completionProtected).toBe(false);
    expect(session.reset()).toBe(false);expect(f.storage.rows.get(f.key)).toBe(f.raw);expect(f.storage.removes).toEqual([]);
  });
  it.each(['draft','marker'])('reads initial storage safely even while clean (%s)',fault=>{
    const f=fixture();f.storage.denied.add(fault==='draft'?f.key:f.marker);const session=f.create();expect(session.getSnapshot().dirty).toBe(false);
    f.storage.denied.clear();session.retryStorage();expect(session.getSnapshot().pending?.value).toEqual(retained);expect(session.getSnapshot().dirty).toBe(false);expect(f.storage.writes).toEqual([]);
  });
  it.each(['capture','retryStorage'])('preserves in-memory UUID and newest values when %s confirms empty storage',operation=>{
    const f=fixture();f.storage.rows.clear();f.storage.denied.add(f.key);const session=f.create();session.capture({...fresh,text:'Latest memory entry'});expect(f.storage.writes).toEqual([]);
    f.storage.denied.clear();if(operation==='capture')session.capture({...fresh,text:'Latest memory entry'});else session.retryStorage();
    expect(session.getSnapshot().initialReadState).toBe('ready');expect(session.getSnapshot().storageError).toBe(false);expect(JSON.parse(f.storage.rows.get(f.key)!).value).toEqual({...fresh,text:'Latest memory entry'});
  });
  it('requires the marker read even when no own draft is present',()=>{
    const f=fixture();f.storage.rows.clear();f.storage.denied.add(f.marker);const session=f.create();session.capture(fresh);
    expect(session.getSnapshot().storageError).toBe(true);expect(f.storage.writes).toEqual([]);f.storage.denied.clear();session.retryStorage();expect(JSON.parse(f.storage.rows.get(f.key)!).value.creationId).toBe(freshId);
  });
  it.each(['invalid','ack'] as const)('requires explicit discard when rereading discovers %s',kind=>{
    const f=fixture('clients',kind);f.storage.denied.add(f.key);const session=f.create();session.capture(fresh);f.storage.denied.clear();session.retryStorage();
    expect(session.getSnapshot().initialReadState).toBe('decision');expect(kind==='ack'?session.getSnapshot().completedResidual:session.getSnapshot().invalid).toBe(true);
    session.capture(fresh);session.keepLocal();session.retryStorage();session.complete(true);expect(f.storage.rows.get(f.key)).toBe(f.raw);expect(f.storage.writes).toEqual([]);
    expect(session.reset()).toBe(true);expect(session.getSnapshot().initialReadState).toBe('ready');expect(f.storage.rows.get(f.key)).toBeUndefined();
  });
  it('does not certify a changing pair of initial draft and marker reads',()=>{
    const f=fixture();f.storage.changedPair=true;const session=f.create();session.capture(fresh);
    expect(session.getSnapshot().initialReadState).toBe('unknown');expect(session.getSnapshot().storageError).toBe(true);expect(f.storage.rows.get(f.key)).toBe(f.raw);expect(f.storage.writes).toEqual([]);
  });
  it('does not erase a newly discovered draft on the same failed-initial-read reset attempt',()=>{
    const f=fixture();f.storage.denied.add(f.key);const session=f.create();f.storage.denied.clear();
    expect(session.reset()).toBe(false);expect(session.getSnapshot().pending?.value).toEqual(retained);expect(f.storage.rows.get(f.key)).toBe(f.raw);expect(f.storage.removes).toEqual([]);
    expect(session.reset()).toBe(true);expect(f.storage.rows.has(f.key)).toBe(false);
  });
  it.each([false,true])('pure initial reread confirms empty storage without persisting or rotating identity (dirty=%s)',dirty=>{
    const f=fixture();f.storage.rows.clear();f.storage.denied.add(f.key);const session=f.create();if(dirty)session.capture({...fresh,text:'Latest unsaved fields'});f.storage.denied.clear();session.retryInitialRead();
    expect(session.getSnapshot().initialReadState).toBe('ready');expect(session.getSnapshot().value.creationId).toBe(freshId);expect(session.getSnapshot().storageError).toBe(dirty);expect(f.storage.writes).toEqual([]);expect(f.storage.removes).toEqual([]);
    if(dirty){session.retryStorage();expect(JSON.parse(f.storage.rows.get(f.key)!).value.creationId).toBe(freshId);expect(session.getSnapshot().storageError).toBe(false);}
  });
  it('logs initial read failure/recovery transitions without one incident per blocked keystroke',()=>{
    const f=fixture();f.storage.rows.clear();f.storage.denied.add(f.key);const before=recentDiagnosticEvents().length;const session=f.create();
    for(let i=0;i<20;i++)session.capture({...fresh,text:'Private business text '+i});
    const blocked=recentDiagnosticEvents().slice(before).filter(row=>row.area==='draft');expect(blocked.filter(row=>row.operation==='form.local_read'&&row.phase==='failure')).toHaveLength(1);expect(f.storage.writes).toEqual([]);
    f.storage.denied.clear();session.retryStorage();expect(recentDiagnosticEvents().slice(before).filter(row=>row.operation==='form.local_read'&&row.phase==='success')).toHaveLength(1);
    f.storage.denied.add(f.key);f.create();expect(recentDiagnosticEvents().slice(before).filter(row=>row.operation==='form.local_read'&&row.phase==='failure')).toHaveLength(2);
    expect(JSON.stringify(recentDiagnosticEvents().slice(before))).not.toMatch(/Private business|synthetic-initial-read|synthetic-local-member|11111111|22222222/);
  });
});
