import { expect, it } from 'vitest';
import { createAutopilotDraftNotices, resolveAutopilotDraftNotice, selectAutopilotDraftNotices, QUOTE_ACTIVITY_LIVE_SELECTOR } from './autopilotDraftNotices';
import type { Quote, Workspace } from './types';
import type { FormDraftIdentityValue } from './useFormDraft';
import { autopilotCopy } from './autopilotPresentation';
import type { ConfirmedQuoteActivity } from './confirmedQuoteActivity';

const event = (id: number): ConfirmedQuoteActivity => ({ activityId: 'activity-'+id, proposalId: 'proposal-'+id,
  quoteId: '00000000-0000-4000-8000-'+String(id).padStart(12, '0'), confirmedAt: 1000 + id,
  kind: 'quote_draft_created', requiresHumanValidation: true });
const encode = (sequence: number, org='org-a', user='user-a', installation='installation-a') =>
  btoa(JSON.stringify(['confirmed-quote-changes-v2',org,user,installation,sequence])).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const page = (sequence: number, ...ids: number[]) => ({ organizationId: 'org-a', items: ids.map(event), nextCursor: encode(sequence) });
const scope = JSON.stringify(['org-a','workspace-a','nonce-a']);
type Tracker = ReturnType<typeof createAutopilotDraftNotices>;
const observe = (notices: Tracker, raw: unknown) => notices.observe(scope,'org-a',raw,notices.selection(scope)!);

it('silently baselines the last50 of600 historical events in a single v2 read', () => {
  const notices=createAutopilotDraftNotices();
  expect(notices.selection(scope)).toEqual({limit:50,cursor:QUOTE_ACTIVITY_LIVE_SELECTOR});
  expect(observe(notices,page(600,...Array.from({length:50},(_,i)=>551+i)))).toBe(true);
  expect(notices.pending(scope)).toEqual([]);expect(notices.selection(scope)?.cursor).toBe(encode(600));
  expect(notices.preview(scope)?.nextCursor).toBeNull();expect(notices.needsDrain(scope)).toBe(false);
});
it('drains600 new events without a history scan, permanent saturation or a timestamp watermark', () => {
  const notices=createAutopilotDraftNotices(), delivered:string[]=[];
  observe(notices,page(600,...Array.from({length:50},(_,i)=>551+i)));
  for(let first=601;first<=1200;first+=50) {
    expect(observe(notices,page(first+49,...Array.from({length:50},(_,i)=>first+i)))).toBe(true);
    delivered.push(...notices.pending(scope).map(item=>item.activityId));
    notices.consume(scope,notices.pending(scope).map(item=>item.activityId));
  }
  expect(delivered).toHaveLength(600);expect(new Set(delivered).size).toBe(600);
  expect(notices.preview(scope)?.items.map(item=>item.activityId)).toEqual(Array.from({length:50},(_,i)=>'activity-'+(1151+i)));
  expect(notices.selection(scope)?.cursor).toBe(encode(1200));
  expect(observe(notices,page(1200))).toBe(true);expect(notices.needsDrain(scope)).toBe(false);
});
it('queues a late canonical event whose captured timestamp precedes the baseline', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(10,10));
  expect(observe(notices,{...page(11),items:[{...event(11),confirmedAt:1}]})).toBe(true);
  expect(notices.pending(scope)[0].activityId).toBe('activity-11');
  expect(notices.preview(scope)?.items.at(-1)?.confirmedAt).toBe(1);
});
it('accepts empty projection gaps without converting sequence deltas into draft counts', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(2));
  expect(observe(notices,page(900))).toBe(true);expect(notices.pending(scope)).toEqual([]);
  expect(notices.selection(scope)?.cursor).toBe(encode(900));
});
it('atomically retains a full pending queue and its cursor until capacity becomes available', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(0));
  observe(notices,page(50,...Array.from({length:50},(_,i)=>i+1)));
  observe(notices,page(100,...Array.from({length:50},(_,i)=>i+51)));
  expect(notices.pending(scope)).toHaveLength(100);expect(notices.selection(scope)).toBeNull();
  expect(notices.observe(scope,'org-a',page(150,...Array.from({length:50},(_,i)=>i+101)),{limit:50,cursor:encode(100)})).toBe(false);
  notices.consume(scope,Array.from({length:25},(_,i)=>'activity-'+(i+1)));
  expect(notices.selection(scope)).toEqual({limit:25,cursor:encode(100)});
  expect(observe(notices,page(125,...Array.from({length:25},(_,i)=>i+101)))).toBe(true);
  expect(notices.pending(scope)).toHaveLength(100);
});
it('admits a valid response after the UI frees queue space during its read', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(0));
  observe(notices,page(50,...Array.from({length:50},(_,i)=>i+1)));
  observe(notices,page(100,...Array.from({length:50},(_,i)=>i+51)));
  notices.consume(scope,['activity-1']);const request=notices.selection(scope)!;
  notices.consume(scope,['activity-2']);
  expect(notices.observe(scope,'org-a',page(101,101),request)).toBe(true);
});
it('keeps pending until the exact local destination arrives and deduplicates repeated idle cursors', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(0));observe(notices,page(1,1));
  for(let n=0;n<5;n++)expect(observe(notices,page(1))).toBe(true);
  expect(notices.pending(scope)).toHaveLength(1);
  expect(notices.consume(scope,['activity-1'])).toBe(true);expect(notices.consume(scope,['activity-1'])).toBe(false);
  expect(observe(notices,page(1))).toBe(true);expect(notices.pending(scope)).toEqual([]);
});
it('refuses a duplicate nonempty cursor, a stale sequence and a response to an obsolete request', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(0));const old=notices.selection(scope)!;
  observe(notices,page(1,1));
  expect(observe(notices,page(1,1))).toBe(false);
  expect(observe(notices,page(0))).toBe(false);
  expect(notices.observe(scope,'org-a',page(2,2),old)).toBe(false);
  expect(notices.selection(scope)?.cursor).toBe(encode(1));expect(notices.pending(scope)).toHaveLength(1);
});
it.each(['org-b','user-b','installation-b'])('rejects a foreign v2 identity (%s)', changed=>{
  const notices=createAutopilotDraftNotices();observe(notices,page(0));
  const token=encode(1,changed.startsWith('org')?changed:'org-a',changed.startsWith('user')?changed:'user-a',changed.startsWith('installation')?changed:'installation-a');
  expect(observe(notices,{...page(1,1),nextCursor:token})).toBe(false);
  expect(notices.selection(scope)?.cursor).toBe(encode(0));
});
it('refuses absent, legacy, malformed, noncanonical and unsafe cursors before establishing a baseline', () => {
  const notices=createAutopilotDraftNotices();
  for(const token of [null,'older',encode(0)+'=',encode(-1),encode(Number.MAX_SAFE_INTEGER+1),btoa(JSON.stringify(['wrong','org-a','user-a','installation-a',0]))])
    expect(observe(notices,{...page(0),nextCursor:token})).toBe(false);
  expect(notices.hasBaseline(scope)).toBe(false);
});
it.each(['org-b','workspace-b','nonce-b'])('silently resets the baseline when context changes (%s)', changed=>{
  const notices=createAutopilotDraftNotices();observe(notices,page(0));observe(notices,page(1,1));
  const next=JSON.stringify([changed,'different-context']);
  expect(notices.hasBaseline(next)).toBe(false);expect(notices.pending(next)).toEqual([]);
  expect(notices.observe(next,'org-a',page(1,1),notices.selection(next)!)).toBe(true);
  expect(notices.pending(next)).toEqual([]);expect(notices.consume(scope,['activity-1'])).toBe(false);
});
it('preserves the exact read cursor and pending events across a transient invalid response', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(1,1));observe(notices,page(2,2));
  expect(observe(notices,null)).toBe(false);expect(notices.selection(scope)?.cursor).toBe(encode(2));
  expect(observe(notices,page(3,3))).toBe(true);
  expect(notices.pending(scope).map(item=>item.activityId)).toEqual(['activity-2','activity-3']);
});
it('refuses changed immutable activity data without consuming its cursor', () => {
  const notices=createAutopilotDraftNotices();observe(notices,page(1,1));
  expect(observe(notices,{...page(2),items:[{...event(1),quoteId:event(2).quoteId}]})).toBe(false);
  expect(notices.selection(scope)?.cursor).toBe(encode(1));
});

const identity: FormDraftIdentityValue = { companyId: 'physical-a', organizationId: 'org-a', memberId: 'member-a',
  memberContextNonce: 'a'.repeat(32), ready: true };
const origin = { workspaceScope: 'physical-a', memberContextNonce: 'a'.repeat(32) };
const quote: Quote = { id: event(1).quoteId, number: '', clientId: 'client-a', projectId: null, title: '', issueDate: '2026-10-14',
  validUntil: '2026-11-14', currency: 'CHF', status: 'draft', lines: [], notes: '', terms: '', createdAt: '2026-10-14T20:00:00Z' };
const workspace: Pick<Workspace, 'workNotesScope' | 'quotes'> = { workNotesScope: 'physical-a', quotes: [] };
it('waits for the asynchronous workspace arrival before consuming a canonical notification', () => {
  const notices = createAutopilotDraftNotices(); observe(notices, page(0)); observe(notices, page(1, 1));
  expect(resolveAutopilotDraftNotice(notices.pending(scope), 'org-a', origin, workspace, identity, { active: true, readOnly: false })).toBeNull();
  expect(notices.pending(scope)).toHaveLength(1);
  const found = resolveAutopilotDraftNotice(notices.pending(scope), 'org-a', origin, { ...workspace, quotes: [quote] }, identity, { active: true, readOnly: false });
  expect(found?.activityId).toBe('activity-1');
  expect(notices.consume(scope, [found!.activityId])).toBe(true); expect(notices.pending(scope)).toEqual([]);
});
it('does not offer another, duplicate or already issued document as a new draft', () => {
  for (const quotes of [[{ ...quote, id: event(2).quoteId }], [quote, quote], [{ ...quote, status: 'issued' as const }]])
    expect(resolveAutopilotDraftNotice([event(1)], 'org-a', origin, { ...workspace, quotes }, identity, { active: true, readOnly: false })).toBeNull();
});
it('rechecks the physical workspace, current member nonce and connected account for the notice destination', () => {
  const pending = [event(1)], loaded = { ...workspace, quotes: [quote] };
  for (const next of [{ ...identity, memberContextNonce: 'b'.repeat(32) }, { ...identity, organizationId: 'org-b' }])
    expect(resolveAutopilotDraftNotice(pending, 'org-a', origin, loaded, next, { active: true, readOnly: false })).toBeNull();
  expect(resolveAutopilotDraftNotice(pending, 'org-a', origin, { ...loaded, workNotesScope: 'physical-b' }, identity, { active: true, readOnly: false })).toBeNull();
  expect(resolveAutopilotDraftNotice(pending, 'org-a', origin, loaded, identity, { active: false, readOnly: false })).toBeNull();
});
it('provides the notification, exact open action and review indicator in all four languages', () => {
  const copies = ['fr', 'de', 'it', 'en'].map(autopilotCopy);
  for (const text of copies) for (const value of [text.newDraft, text.openDraft, text.reviewIndicator]) expect(value.trim()).not.toBe('');
  expect(new Set(copies.map(text => text.newDraft)).size).toBe(4);
});
it('silently retires100 exact already-finalised drafts so the101st new draft is not blocked', () => {
  const notices=createAutopilotDraftNotices(); observe(notices,page(0));
  observe(notices,page(50,...Array.from({length:50},(_,i)=>i+1)));
  observe(notices,page(100,...Array.from({length:50},(_,i)=>i+51)));
  expect(notices.selection(scope)).toBeNull();
  const quotes=Array.from({length:100},(_,i)=>({...quote,id:event(i+1).quoteId,status:'issued' as const}));
  const selected=selectAutopilotDraftNotices(notices.pending(scope),'org-a',origin,{...workspace,quotes},identity,{active:true,readOnly:false});
  expect(selected.draft).toBeNull();expect(selected.handled).toHaveLength(100);
  notices.consume(scope,selected.handled);
  expect(notices.selection(scope)).toEqual({limit:50,cursor:encode(100)});
  expect(observe(notices,page(101,101))).toBe(true);
  const next=selectAutopilotDraftNotices(notices.pending(scope),'org-a',origin,{...workspace,quotes:[...quotes,{...quote,id:event(101).quoteId}]},identity,{active:true,readOnly:false});
  expect(next.draft?.activityId).toBe('activity-101');expect(next.handled).toEqual([]);
});
it('retires only exact known non-draft statuses, retaining missing, ambiguous, unknown or changed-context documents', () => {
  for(const status of ['issued','accepted','refused','expired','cancelled'] as const) {
    expect(selectAutopilotDraftNotices([event(1)],'org-a',origin,{...workspace,quotes:[{...quote,status}]},identity,{active:true,readOnly:false}).handled).toEqual(['activity-1']);
  }
  for(const quotes of [[],[quote,quote],[{...quote,status:'unknown' as Quote['status']}]])
    expect(selectAutopilotDraftNotices([event(1)],'org-a',origin,{...workspace,quotes},identity,{active:true,readOnly:false}).handled).toEqual([]);
  expect(selectAutopilotDraftNotices([event(1)],'org-a',origin,{...workspace,quotes:[{...quote,status:'issued'}]},
    {...identity,memberContextNonce:'b'.repeat(32)},{active:true,readOnly:false}).handled).toEqual([]);
});
