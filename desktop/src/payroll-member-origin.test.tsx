// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
/** Real bridge and real extracted production callback expressions. Closed native
 * IPC only; no React component/layout, hook or SQLite authority proof. */
import detailedSource from './DetailedPayslipForm.tsx?raw';
import ts from 'typescript';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {desktopApi} from './bridge';
import {workspaceOriginFailure} from './workspaceOrigin';
import {WorkspaceRefreshAfterMutationError} from './workspaceMutation';
import {WorkspaceMemberOriginChangedError,type WorkspaceMutationOrigin} from './workspaceMemberOrigin';
import {bindWorkspaceMutationRead} from './memberOriginBridge';
import type {PayslipLine,PayrollContributionSelection} from './types';
const native=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:native.invoke,isTauri:()=>false}));
vi.hoisted(()=>{globalThis.fetch=async()=>{throw Error('Network forbidden during payroll origin test import');};Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});});
const scope='payroll-origin-company',nonceA='a'.repeat(32),nonceB='b'.repeat(32);
const origin:WorkspaceMutationOrigin=Object.freeze({workspaceScope:scope,memberContextNonce:nonceA});
const data={employeeId:'employee',period:'2026-09',paymentDate:'2026-09-30',status:'incomplete',notes:'Notes de recette'};
const lines:PayslipLine[]=[{id:'new-line',label:'Salaire',kind:'earning',amountCents:500000},{id:'retained-line',label:'AVS',kind:'deduction',amountCents:26500,postingAccountId:'social-account'}];
const selections:PayrollContributionSelection[]=[{definitionId:'contribution',basisCents:500000,yearToDateBasisCents:4000000}];
let currentScope=scope,currentNonce=nonceA,mode='',writes=0,external=0;
const save=()=>desktopApi.savePayslipWithContributions(data,lines,undefined,data.period,selections,origin.workspaceScope,origin.memberContextNonce);
function guard(args:any){if(args?.expectedWorkspaceScope!==undefined&&args.expectedWorkspaceScope!==currentScope)throw Error('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==currentNonce)throw 'Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';}
beforeEach(()=>{currentScope=scope;currentNonce=nonceA;mode='';writes=0;external=0;vi.stubGlobal('fetch',vi.fn(async()=>{external++;throw Error('No network in closed payroll fixture');}));native.invoke.mockReset();native.invoke.mockImplementation(async(command:string,args:any)=>{
  if(command==='append_diagnostic_events')return;
  guard(args);
  if(command==='save_payslip_with_contributions'){writes++;if(mode==='ack-member')currentNonce=nonceB;if(mode==='lost')throw Error('Synthetic ACK lost after commit');return {id:'saved-payslip'};}
  if(command==='get_app_state'){if(mode==='read-failure')throw Error('Synthetic local read unavailable');return {onboarding_completed:true};}
  if(command==='get_workspace')return {work_notes_scope:currentScope,payslips:[],settings:null};
  throw Error('Closed payroll fixture rejects '+command);
});});
afterEach(()=>{expect(external).toBe(0);expect(native.invoke.mock.calls.some(([command])=>command==='get_form_draft_identity'||command==='get_cloud_account_state')).toBe(false);vi.unstubAllGlobals();});
describe('atomic payroll bridge original member context',()=>{
  it('forwards the original pair to the atomic write and both readback commands without changing amounts',async()=>{
    const result=await save();expect(result.workNotesScope).toBe(scope);expect(writes).toBe(1);
    const commands=native.invoke.mock.calls.filter(([name])=>name!=='append_diagnostic_events');expect(commands.map(([name])=>name)).toEqual(['save_payslip_with_contributions','get_app_state','get_workspace']);
    for(const [,args]of commands)expect(args).toMatchObject({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});
    expect(commands[0][1].input.lines.map((line:any)=>line.amount_cents)).toEqual([500000,26500]);expect(commands[0][1].input.contributions).toEqual([{definition_id:'contribution',basis_cents:500000,year_to_date_basis_cents:4000000}]);
  });
  it('refuses the write if the local member has changed before the simulated native lock',async()=>{currentNonce=nonceB;await expect(save()).rejects.toBeInstanceOf(WorkspaceMemberOriginChangedError);expect(writes).toBe(0);});
  it('retains a terminal original-context error after ACK rather than acknowledging the new member',async()=>{mode='ack-member';let failure:unknown;try{await save();}catch(error){failure=error;}expect(writes).toBe(1);expect(failure).toBeInstanceOf(WorkspaceRefreshAfterMutationError);expect(workspaceOriginFailure(failure)).toBeInstanceOf(WorkspaceMemberOriginChangedError);expect(native.invoke.mock.calls.filter(([name])=>name==='save_payslip_with_contributions')).toHaveLength(1);});
  it('keeps ACK/read failure recoverable by an original-bound read, without replaying the atomic mutation',async()=>{mode='read-failure';const read=bindWorkspaceMutationRead(origin,desktopApi.loadWorkspace);await expect(save()).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);currentNonce=nonceB;mode='';await expect(read()).rejects.toBeInstanceOf(WorkspaceMemberOriginChangedError);expect(writes).toBe(1);expect(native.invoke.mock.calls.filter(([name])=>name==='save_payslip_with_contributions')).toHaveLength(1);});
  it('does not pretend a lost ACK has proved a commit or automatically repeat the command',async()=>{mode='lost';await expect(save()).rejects.toThrow('Synthetic ACK lost');expect(writes).toBe(1);expect(native.invoke.mock.calls.filter(([name])=>name==='get_workspace')).toHaveLength(0);});
  it('preserves the explicitly historical optional-argument IPC contract',async()=>{await desktopApi.savePayslipWithContributions(data,lines,undefined,data.period,selections);expect(native.invoke.mock.calls.find(([name])=>name==='save_payslip_with_contributions')?.[1]).not.toHaveProperty('expectedMemberContextNonce');expect(writes).toBe(1);});
  it.each([0,1])('executes real production DetailedPayslipForm callback %s with the captured origin',async(index)=>{
    const ast=ts.createSourceFile('DetailedPayslipForm.tsx',detailedSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),callbacks:string[]=[];
    const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.getText(ast)==='desktopApi.savePayslipWithContributions'){let parent:ts.Node|undefined=node.parent;while(parent&&!ts.isArrowFunction(parent))parent=parent.parent;if(!parent)throw Error('No production callback');callbacks.push(parent.getText(ast));}ts.forEachChild(node,visit);};visit(ast);expect(callbacks).toHaveLength(2);
    const callback=new Function('desktopApi','data','lines','item','period','selectedItems','employeeId','paymentDate','notes','return ('+callbacks[index]+');')(desktopApi,data,lines,undefined,data.period,selections,data.employeeId,data.paymentDate,data.notes) as (value:WorkspaceMutationOrigin)=>Promise<unknown>;
    await callback(origin);expect(writes).toBe(1);const args=native.invoke.mock.calls.find(([name])=>name==='save_payslip_with_contributions')![1];expect(args).toMatchObject({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});expect(args.input.contributions).toHaveLength(index===0?0:1);expect(args.input.lines.map((line:any)=>line.amount_cents)).toEqual([500000,26500]);
  });
});
