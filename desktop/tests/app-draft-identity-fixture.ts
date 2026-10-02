import { desktopApi, type CloudAccountState } from '../src/bridge';
import { recentDiagnosticEvents } from '../src/diagnostics';
import { refreshReceivedCompany } from '../src/companySync';
import type { LicenseState, Workspace } from '../src/types';

type ReadMode = 'ready'|'hold'|'failure'|'missing';
type IdentityRead = { id:number; memberId:string; mode:ReadMode; pending:boolean };

/** Synthetic, non-shipping acceptance fixture for the real App and account gate. */
export function installAppDraftIdentityFixture(workspace: Workspace) {
  const params = new URLSearchParams(location.search);
  workspace.workNotesScope = params.has('identityMissingScope') ? undefined : 'synthetic-company-a';
  let account: CloudAccountState = params.has('identityLocalAccount') ? {status:'disconnected'} : {status:'connected',organizationId:'automation-qa',organizationName:'Entreprise fictive A',role:'owner'};
  if (params.has('identityInitiallyInactive')) account.status = 'inactive';
  let memberId = 'synthetic-member-a';
  let identityMode:ReadMode = 'hold', accountMode:ReadMode = 'hold';
  let holdCompany = params.has('identityCompanyHold');
  let linkTarget = {...account}, linkMember = memberId, linkScope = workspace.workNotesScope;
  const identities = new Map<number, {resolve:(value:{memberId?:string})=>void; reject:(reason:Error)=>void}>();
  const accounts = new Map<number, {resolve:(value:CloudAccountState)=>void; reject:(reason:Error)=>void}>();
  const companies = new Map<number, ()=>void>();
  const proof = { identityReads:[] as IdentityRead[], accountReads:0, companyResolutions:[] as {organizationId:string;changed:boolean}[], nativeCalls:[] as string[] };
  const license:LicenseState = {enforcementConfigured:true,status:'valid',readOnly:false,canRefresh:false,accessRole:'owner',installationId:'synthetic-installation',reason:''};
  desktopApi.loadWorkspace = async () => structuredClone(workspace);
  desktopApi.getLicenseState = async () => ({...license,...account.status==='inactive'?{status:'inactive',readOnly:true}:{}});
  desktopApi.getCachedCloudAccountState = async () => structuredClone(account);
  desktopApi.getCloudAccountState = async () => {
    const id = ++proof.accountReads;
    if (accountMode === 'failure') throw new Error('SYNTHETIC_PRIVATE_ACCOUNT_FAILURE');
    if (accountMode === 'hold') return new Promise<CloudAccountState>((resolve,reject) => accounts.set(id,{resolve,reject}));
    return structuredClone(account);
  };
  desktopApi.getCloudTeam = async () => ({organizationId:account.organizationId!,organizationName:account.organizationName!,canManage:false,profile:null,members:[],invitations:[],seats:{planName:'Fictif',limit:3,used:1,reserved:0,available:2,subscriptionActive:true},role:'owner'});
  desktopApi.resolveConnectedCompany = async organizationId => {
    if (holdCompany) await new Promise<void>(resolve=>companies.set(proof.companyResolutions.length + 1,resolve));
    const changed = linkScope !== workspace.workNotesScope;
    if (changed) {
      workspace.workNotesScope = linkScope;
      workspace.settings!.organization.legalName = account.organizationName!;
      workspace.clients = [{...workspace.clients[0],id:'synthetic-client-b',name:'Client fictif B',company:'Client fictif B'}];
    }
    proof.companyResolutions.push({organizationId,changed});
    return {status:'ready',organizationId,changed};
  };
  const native = (window as unknown as {__TAURI_INTERNALS__:{invoke:(command:string,args?:unknown)=>Promise<unknown>}}).__TAURI_INTERNALS__;
  const previousInvoke = native.invoke;
  native.invoke = async (command,args) => {
    proof.nativeCalls.push(command);
    if (command === 'get_form_draft_identity') {
      const id = proof.identityReads.length + 1;
      const read = {id,memberId,mode:identityMode,pending:identityMode==='hold'};
      proof.identityReads.push(read);
      if (identityMode === 'failure') throw new Error('SYNTHETIC_PRIVATE_IDENTITY_FAILURE');
      if (identityMode === 'missing') return {};
      if (identityMode === 'hold') return new Promise<{memberId?:string}>((resolve,reject) => identities.set(id,{resolve,reject}));
      return {memberId};
    }
    if (command === 'append_diagnostic_events') return;
    if (command === 'start_cloud_account_link') return {status:'pending',userCode:'SYNTHETIC-CODE',verificationUri:'https://example.invalid',authorizationExpiresAt:'2099-01-01T00:00:00Z',intervalSeconds:3};
    if (command === 'open_cloud_account_link') return 'https://example.invalid';
    if (command === 'poll_cloud_account_link') { account = structuredClone(linkTarget); memberId = linkMember; return structuredClone(account); }
    // Existing Automation handlers accept read-only activity; never forward any
    // business/account mutation outside the small synthetic link above.
    if (['automation_request','supplier_inbox_request','appointment_inbox_request'].includes(command)) {
      if ((args as {data?:unknown}|undefined)?.data) throw Error('Identity fixture forbids business writes');
      return previousInvoke(command,args);
    }
    throw Error(`Synthetic identity fixture blocks ${command}`);
  };
  const qa = {
    proof,
    identityMode(mode:ReadMode) { identityMode=mode; },
    accountMode(mode:ReadMode) { accountMode=mode; },
    companyMode(mode:'hold'|'ready') { holdCompany=mode==='hold'; },
    setAccount(next:CloudAccountState, nextMember = memberId) { account=structuredClone(next); memberId=nextMember; },
    setScope(scope:string) { workspace.workNotesScope=scope; },
    async receiveScope(scope:string) { workspace.workNotesScope=scope;linkScope=scope;await refreshReceivedCompany(); },
    releaseCompany(id:number) { const release=companies.get(id);if(!release)throw Error('No held company resolution');release();companies.delete(id); },
    companyPending() { return [...companies.keys()]; },
    link(next:CloudAccountState, nextMember:string, scope=workspace.workNotesScope) { linkTarget=structuredClone(next);linkMember=nextMember;linkScope=scope; },
    releaseIdentity(id:number,nextMember?:string) { const pending=identities.get(id); if(!pending)throw Error('No held identity read'); const read=proof.identityReads.find(item=>item.id===id)!;read.pending=false;pending.resolve({memberId:nextMember??read.memberId});identities.delete(id); },
    rejectIdentity(id:number) { const pending=identities.get(id);if(!pending)throw Error('No held identity read');proof.identityReads.find(item=>item.id===id)!.pending=false;pending.reject(Error('SYNTHETIC_PRIVATE_LATE_IDENTITY_FAILURE'));identities.delete(id); },
    releaseAccount(id:number) { const pending=accounts.get(id);if(!pending)throw Error('No held account read');pending.resolve(structuredClone(account));accounts.delete(id); },
    diagnostics() { return recentDiagnosticEvents().filter(event=>event.operation==='identity.read'); },
  };
  Object.assign(window,{__qaAppDraftIdentity:qa,__ZENTRA_NATIVE_READY__:true});
}
