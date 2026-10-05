import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime',()=>({database:()=>{throw new Error('No database needed by the resume decoder');}}));
vi.mock('@/lib/supplier-inbox/service',()=>({mailReceiptId:vi.fn(),workspaceLink:vi.fn()}));
import {decodeMailScanResume,encodeMailScanResume} from './mail-scan-state';
import {SupportError} from './types';
import {mailDate} from './infomaniak';

const TIME=1_800_000_000;
const valid=()=>({version:1 as const,identity:'a'.repeat(64),link:'b'.repeat(64),offset:20,count:20,
  createdAt:TIME,latestUid:'100',messages:[{uid:'80',date:TIME},{uid:'79',date:null}]});
beforeEach(()=>{vi.spyOn(Date,'now').mockReturnValue(TIME*1000);});
afterEach(()=>vi.restoreAllMocks());
it('round-trips only closed resume metadata and exact remaining UID order',()=>{
  expect(decodeMailScanResume(encodeMailScanResume(valid()))).toEqual(valid());
  expect(encodeMailScanResume(valid())).not.toMatch(/@|password|subject|body|token|https:/);
});
it.each([
  ['decimal seconds',TIME+0.123],
  ['unix milliseconds',TIME*1000+123],
  ['ISO milliseconds',new Date(TIME*1000+123).toISOString()],
])('preserves the actual provider parser date exactly across a resume: %s',(_label,input)=>{
  const date=mailDate(input);
  expect(date).toBe(TIME+0.123);
  const state={...valid(),messages:[{uid:'80',date}]};
  const encoded=encodeMailScanResume(state);
  expect(decodeMailScanResume(encoded)).toEqual(state);
  expect(decodeMailScanResume(encoded)?.messages[0].date).toBe(date);
});
it.each([
  {extra:'private'}, {version:2}, {identity:'not-a-hash'}, {link:'not-a-hash'},
  {offset:-1}, {count:-1}, {count:Number.MAX_SAFE_INTEGER+1},
  {createdAt:TIME+61}, {createdAt:TIME-3601}, {latestUid:'not-a-uid'},
  {messages:[{uid:'not-a-uid',date:null}]}, {messages:[{uid:'1',date:-1}]},
  {messages:[{uid:'1',date:null,body:'private'}]},
  {messages:[{uid:'1',date:null},{uid:'1',date:null}]},
  {messages:Array.from({length:1025},(_,index)=>({uid:String(index+1),date:null}))},
])('rejects incompatible or unbounded saved state without trusting it: %j',change=>{
  expect(decodeMailScanResume(JSON.stringify({...valid(),...change}))).toBeNull();
});
it.each([null,undefined,'','{','[]','x'.repeat(64001)])('never treats malformed state as a cursor: %s',raw=>{
  expect(decodeMailScanResume(raw)).toBeNull();
});
it('refuses to persist an invalid or oversized new resume instead of dropping the pending UID silently',()=>{
  const state={...valid(),messages:Array.from({length:1025},(_,index)=>({uid:String(index+1),date:null}))};
  let refusal:unknown;
  try{encodeMailScanResume(state);}catch(error){refusal=error;}
  expect(refusal).toBeInstanceOf(SupportError);expect(refusal).toMatchObject({status:502});
  expect(state.messages).toHaveLength(1025);expect(state.messages.at(-1)?.uid).toBe('1025');
});
