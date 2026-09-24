import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { LicenseState } from '../src/types';
const nativeAccountRead = desktopApi.getCloudAccountState;

/** Development only: the real App opens while /me deliberately takes ten seconds. */
export function installStartupPerformanceFixture() {
  const started = performance.now();
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const account: CloudAccountState = {status:'connected',organizationId:'automation-qa',organizationName:'Atelier de test',role:'owner',sessionExpiresAt:'2036-10-02T10:00:00Z'};
  const license = {enforcementConfigured:true,status:'valid',readOnly:false,canRefresh:false,accessRole:'owner',installationId:'55af29dd-fdaa-4993-ae78-17f9ca220e51',reason:''} as LicenseState;
  desktopApi.getCachedCloudAccountState = async () => { await delay(20); return account; };
  desktopApi.getLicenseState = async () => license;
  const native = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const previousInvoke = native.invoke;
  // Exercise the production bridge (including concurrent request sharing).
  desktopApi.getCloudAccountState = nativeAccountRead;
  native.invoke = async (command, args) => {
    if (command !== 'get_cloud_account_state') return previousInvoke(command, args);
    document.body.dataset.accountNetworkCalls = String(Number(document.body.dataset.accountNetworkCalls || 0) + 1);
    document.body.dataset.accountNetwork = 'pending';
    await delay(10_000);
    document.body.dataset.accountNetwork = 'complete';
    return account;
  };
  // Opening the account panel must not trigger real team/network mutations.
  desktopApi.getCloudTeam = async () => ({organizationId:'automation-qa',organizationName:'Atelier de test',canManage:false,profile:null,members:[],invitations:[],seats:{planName:'Test',limit:3,used:1,reserved:0,available:2,subscriptionActive:true},role:'owner'});
  desktopApi.resolveConnectedCompany = async organizationId => { await delay(20); return {status:'ready',organizationId,changed:false}; };
  Object.assign(window, {__ZENTRA_NATIVE_READY__:true});
  const observer = new MutationObserver(() => {
    if (document.querySelector('.desktop-app') && !document.body.dataset.workspaceReadyMs)
      document.body.dataset.workspaceReadyMs = (performance.now() - started).toFixed(0);
    if (document.querySelector('.automation-brief') && !document.body.dataset.automationReadyMs)
      document.body.dataset.automationReadyMs = (performance.now() - started).toFixed(0);
    if (document.body.dataset.workspaceReadyMs && document.body.dataset.automationReadyMs) observer.disconnect();
  });
  observer.observe(document.body, {childList:true,subtree:true});
}
