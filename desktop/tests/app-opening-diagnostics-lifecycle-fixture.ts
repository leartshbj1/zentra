// Non-shipping fixture: no native DB, account, API, OS clipboard or user data.
import {recentDiagnosticEvents} from '../src/diagnostics';
import {setAppLanguage, type AppLanguage} from '../src/language';
import {getUserError} from '../src/userErrors';

export async function installAppOpeningDiagnosticsFixture() {
  const held = new Map<number, {resolve:(value:unknown)=>void; reject:(reason:unknown)=>void}>();
  const reads: {id:number;mode:string}[] = [], appStates:string[] = [], nativeCalls:string[] = [], blockedNative:string[] = [];
  const appended:unknown[] = [], copies:string[] = [];
  let mode = 'hold', serial = 0;
  const invoke = async (command:string, args?:{events?:unknown[]}) => {
    nativeCalls.push(command);
    if (command === 'get_app_state') { appStates.push(mode); return {onboarding_completed:mode!=='success',activity_profile_required:false,app_version:'synthetic'}; }
    if (command === 'get_workspace') {
      const id = ++serial; reads.push({id,mode});
      if (mode === 'hold') return new Promise((resolve,reject)=>held.set(id,{resolve,reject}));
      if (mode === 'reject') throw 'SYNTHETIC_PRIVATE_FIXED_OPEN_FAILURE';
      throw Error('No synthetic workspace response configured');
    }
    if (command === 'get_cached_cloud_account_state' || command === 'get_cloud_account_state') return {status:'disconnected'};
    if (command === 'get_license_state') return {enforcement_configured:false,status:'valid',read_only:false,can_refresh:false,access_role:'owner'};
    if (command === 'append_diagnostic_events') { appended.push(...structuredClone(args?.events ?? [])); return; }
    if (command === 'get_noga_catalog') return {sections:[]};
    if (command === 'is_native_ready') return true;
    blockedNative.push(command); throw Error('Closed synthetic transport refuses '+command);
  };
  Object.assign(window,{__TAURI_INTERNALS__:{invoke,transformCallback:()=>1,unregisterCallback:()=>{},convertFileSrc:(path:string)=>path},__ZENTRA_NATIVE_READY__:true});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(code:string)=>{copies.push(code);}}});
  await setAppLanguage('fr');
  Object.assign(window,{__qaOpening:{reads,appStates,nativeCalls,blockedNative,appended,copies,
    mode(value:string) { mode=value; },
    rejectOld(id:number) { const request=held.get(id);if(!request)throw Error('No held opening read');request.reject('SYNTHETIC_PRIVATE_LATE_OLD_FAILURE');held.delete(id); },
    diagnostics:recentDiagnosticEvents, setLanguage:setAppLanguage,
    expectedReadAction:(language:AppLanguage)=>getUserError(new Error('SYNTHETIC_PRIVATE_FIXED_OPEN_FAILURE'),{operation:'read',language}).action,
  }});
}
