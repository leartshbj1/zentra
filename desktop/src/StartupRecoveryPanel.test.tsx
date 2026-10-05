// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLanguage } from './language';

const state = vi.hoisted(() => ({
  language:'fr' as AppLanguage, probe:vi.fn(), export:vi.fn(), workspace:vi.fn(), localAccess:vi.fn(),
  revalidator:vi.fn(), refreshLicense:vi.fn(), workspaceImport:vi.fn(), diagnostic:vi.fn(),
}));
vi.mock('./language', async original => ({...await original<typeof import('./language')>(), useAppLanguage:()=>state.language}));
vi.mock('./diagnostics', async original => ({
  ...await original<typeof import('./diagnostics')>(),
  diagnosticInvoke:state.probe,
  recordDiagnostic:state.diagnostic,
  resolveErrorIncident:()=>({code:'ZT-TEST-BOOT'}),
  diagnosticsApi:{export:state.export},
}));
vi.mock('./bridge',()=>({desktopApi:{loadWorkspace:state.workspace,refreshLicense:state.refreshLicense}}));
vi.mock('./cloudAccessRevalidation',()=>({
  CLOUD_ACCESS_REVALIDATION_INTERVAL_MS:60000,
  cloudAccountChangeNeedsLicenseRefresh:()=>false,
  createSingleFlightCloudAccessRevalidator:()=>Object.assign(state.revalidator,{invalidate:vi.fn()}),
  readLocalCloudAccess:state.localAccess,readCloudAccessForAccount:vi.fn(),
}));
vi.mock('./useMobileLayout',()=>({useMobileLayout:()=>{}}));
vi.mock('./AppUpdater',()=>({AppUpdater:()=> <div data-test-updater>Updater</div>}));
vi.mock('./BusinessProfileEditor',()=>({BusinessProfileGate:()=>null}));
vi.mock('./DevelopmentNotice',()=>({DevelopmentNotice:()=>null}));
vi.mock('./CloudAccountAccess',()=>({CloudAccountAccess:()=>null}));
vi.mock('./CompanyAccountGate',()=>({CompanyAccountGate:()=>null}));
vi.mock('./useFormDraft',()=>({FormDraftIdentityProvider:()=>null}));
vi.mock('./WorkspaceApp',()=>{state.workspaceImport();return {WorkspaceApp:()=>null};});

import { App } from './App';
import { StartupRecoveryPanel } from './StartupRecoveryPanel';
import { APP_OPEN_TIMEOUT_MS, STARTUP_RECOVERY_REFUSAL, isStartupRecoveryFailure, waitForNativeStartup } from './appOpening';
import { classifyDiagnosticError } from './diagnostics';

let host:HTMLDivElement, root:Root;
beforeEach(()=>{
  vi.useRealTimers();vi.clearAllMocks();state.language='fr';
  state.probe.mockRejectedValue(STARTUP_RECOVERY_REFUSAL);
  state.diagnostic.mockReturnValue('OPEN-TEST');
  state.export.mockResolvedValue('D:/CI-only/exports/Zentra-diagnostics.jsonl');
  Object.assign(window,{__TAURI_INTERNALS__:{},__ZENTRA_NATIVE_READY__:false});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{
  await act(async()=>root.unmount());host.remove();vi.useRealTimers();
  delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string,unknown>).__ZENTRA_NATIVE_READY__;
});
async function mount(element:React.ReactNode){await act(async()=>{root.render(element);await Promise.resolve();});}
async function click(button:HTMLButtonElement){await act(async()=>{button.click();await Promise.resolve();});}
function buttons(){return Array.from(host.querySelectorAll('button'));}
function exportButton(){return buttons().find(button=> /Exporter le diagnostic|Diagnose exportieren|Esporta diagnostica|Export diagnostics/.test(button.textContent||''))!;}
function assertNoBusiness(){
  expect(state.workspace).not.toHaveBeenCalled();expect(state.localAccess).not.toHaveBeenCalled();
  expect(state.revalidator).not.toHaveBeenCalled();expect(state.refreshLicense).not.toHaveBeenCalled();
  expect(state.workspaceImport).not.toHaveBeenCalled();
}

describe('écran de récupération réel, sans magasin métier',()=>{
  const cases = [
    ['fr','Récupération locale à terminer','Fermez puis rouvrez Zentra.','Diagnostic exporté.','Le diagnostic n’a pas pu être exporté.'],
    ['de','Lokale Wiederherstellung abschließen','Schließen Sie Zentra und öffnen Sie es erneut.','Diagnose exportiert.','Die Diagnose konnte nicht exportiert werden.'],
    ['it','Completare il ripristino locale','Chiudi e riapri Zentra.','Diagnostica esportata.','Non è stato possibile esportare la diagnostica.'],
    ['en','Complete local recovery','Close and reopen Zentra.','Diagnostics exported.','Diagnostics could not be exported.'],
  ] as const;
  it.each(cases)('App coupe les lectures puis affiche la récupération en %s',async(language,title,action,exported,failed)=>{
    state.language=language;
    await mount(<App/>);
    expect(host.querySelector('[data-startup-recovery]')).not.toBeNull();
    expect(host.textContent).toContain(title);expect(host.textContent).toContain(action);
    expect(host.textContent).toContain('ZT-OPEN-TEST');
    expect(host.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(host.querySelector('pre')?.textContent).toContain(STARTUP_RECOVERY_REFUSAL);
    expect(buttons().some(button=> /Réessayer|Retry account|Prüfung erneut|Riprova/.test(button.textContent||''))).toBe(false);
    expect(host.querySelectorAll('input')).toHaveLength(0);
    expect(state.probe).toHaveBeenCalledWith('is_native_ready');
    expect(state.export).not.toHaveBeenCalled();assertNoBusiness();
    await click(exportButton());expect(host.textContent).toContain(exported);
    state.export.mockRejectedValueOnce(new Error('Safe diagnostic refusal'));
    await click(exportButton());expect(host.textContent).toContain(failed);
    expect(host.querySelectorAll('details')).toHaveLength(2);assertNoBusiness();
  });
  it('reste fermé sous les doubles effets StrictMode et après un signal tardif',async()=>{
    await mount(<StrictMode><App/></StrictMode>);
    expect(host.querySelector('[data-startup-recovery]')).not.toBeNull();assertNoBusiness();
    window.dispatchEvent(new Event('zentra:native-ready'));
    await act(async()=>{await Promise.resolve();});assertNoBusiness();
    expect(state.export).not.toHaveBeenCalled();
  });
  it('la copie reste dédiée malgré le classement diagnostic VALIDATION du code opaque',async()=>{
    expect(classifyDiagnosticError(STARTUP_RECOVERY_REFUSAL)).toBe('VALIDATION');
    await mount(<App/>);
    expect(host.textContent).toContain('Récupération locale à terminer');
    expect(host.textContent).not.toContain('Corrigez les champs');assertNoBusiness();
    expect(state.diagnostic).toHaveBeenCalledWith(expect.objectContaining({operation:'workspace.open',phase:'failure',errorCode:'VALIDATION'}));
  });
  it('exporte explicitement par diagnosticsApi seulement et garde l’espace fermé',async()=>{
    await mount(<App/>);await click(exportButton());
    expect(state.export).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Diagnostic exporté.');
    expect(host.textContent).toContain('D:/CI-only/exports/Zentra-diagnostics.jsonl');assertNoBusiness();
    expect(buttons().some(button=> /Ouvrir le dossier|Effacer|Restaurer|Importer/.test(button.textContent||''))).toBe(false);
  });
  it('conserve un refus d’export expurgé dans les détails sans le classer comme champ à corriger',async()=>{
    state.export.mockRejectedValue(new Error('Le diagnostic récent ne peut pas être conservé. token=SECRET_TEST'));
    await mount(<App/>);await click(exportButton());
    expect(host.textContent).toContain('Le diagnostic n’a pas pu être exporté.');
    expect(host.textContent).not.toContain('SECRET_TEST');
    expect(host.textContent).not.toContain('Informations à vérifier');
    expect(host.querySelectorAll('details')).toHaveLength(2);assertNoBusiness();
  });
  it('borne les doubles clics et ignore l’export arrivé après démontage',async()=>{
    let finish!:(value:string)=>void;
    state.export.mockImplementation(()=>new Promise<string>(resolve=>{finish=resolve;}));
    await mount(<App/>);
    await act(async()=>{exportButton().click();exportButton().click();await Promise.resolve();});
    expect(state.export).toHaveBeenCalledTimes(1);expect(exportButton()?.disabled ?? buttons().some(b=>b.disabled)).toBe(true);
    await act(async()=>{root.render(null);finish('D:/late/export.jsonl');await Promise.resolve();});
    expect(host.textContent).toBe('');assertNoBusiness();
  });
  it('copie la référence d’incident sans commande métier',async()=>{
    const writeText=vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
    await mount(<App/>);
    await click(buttons().find(b=>b.getAttribute('aria-label')==='Copier le code')!);
    expect(writeText).toHaveBeenCalledWith('ZT-OPEN-TEST');assertNoBusiness();
  });
  it('ouvre seulement la mise à jour sur demande explicite',async()=>{
    await mount(<App/>);
    expect(host.querySelector('[data-test-updater]')).toBeNull();
    await click(buttons().find(b=> /Mise à jour/.test(b.textContent||''))!);
    expect(document.body.querySelector('[data-test-updater]')).not.toBeNull();assertNoBusiness();
  });
  it('préserve le délai générique et Réessayer pour un refus IPC ordinaire',async()=>{
    vi.useFakeTimers();state.probe.mockRejectedValue(new Error('transport temporaire'));
    await mount(<App/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(APP_OPEN_TIMEOUT_MS);});
    expect(host.querySelector('[data-startup-recovery]')).toBeNull();
    expect(buttons().some(b=>b.textContent==='Réessayer')).toBe(true);assertNoBusiness();
  });
  it('rejette une marque fabriquée et ne relit pas le moteur lors d’une seconde attente',async()=>{
    expect(isStartupRecoveryFailure(new Error(STARTUP_RECOVERY_REFUSAL))).toBe(false);
    const target=Object.assign(new EventTarget(),{__TAURI_INTERNALS__:{},__ZENTRA_NATIVE_READY__:false});
    const probe=vi.fn().mockRejectedValue(STARTUP_RECOVERY_REFUSAL);
    const failure=await waitForNativeStartup(target,probe).catch(e=>e);
    expect(isStartupRecoveryFailure(failure)).toBe(true);
    await mount(<StartupRecoveryPanel error={failure} incidentCode="ZT-EXPLICIT"/>);
    expect(probe).toHaveBeenCalledTimes(1);expect(state.export).not.toHaveBeenCalled();assertNoBusiness();
  });
});
