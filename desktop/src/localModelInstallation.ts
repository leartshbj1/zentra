import { payrollLocalAi } from './payrollLocalAi';
type State = { phase: 'unknown' | 'checking' | 'missing' | 'installed' | 'installing' | 'removing' | 'error'; label: string; percent: number | null; error: string; deferred: boolean };
const preferenceKey = 'zentra.local-assistant.preference.v1';
function preference() { try { return localStorage.getItem(preferenceKey) === 'later'; } catch { return false; } }
let state: State = { phase:'unknown', label:'', percent:null, error:'', deferred:preference() };
const listeners = new Set<() => void>();
const update = (patch: Partial<State>) => { state = {...state,...patch}; listeners.forEach(fn=>fn()); };
let operation: Promise<void> | null = null;
let generation = 0;
function remember(value: string) { try { localStorage.setItem(preferenceKey,value); } catch { /* The current choice still works for this session. */ } }
function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/quota|storage|disk|space/i.test(message)) return 'Il manque de la place pour Qwen. Libérez de l’espace sur cet appareil, puis réessayez.';
  if (/fetch|network|download|failed to load/i.test(message)) return 'Le téléchargement n’a pas abouti. Vérifiez votre connexion, puis réessayez.';
  return message || 'Qwen n’a pas pu démarrer sur cet appareil. Vous pouvez continuer à utiliser Zentra et réessayer plus tard.';
}
export const localModelInstallation = {
  getSnapshot: () => state,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  async inspect() {
    if (operation || state.phase === 'checking' || payrollLocalAi.isBusy()) return;
    update({phase:'checking',error:''});
    try { update({phase: await payrollLocalAi.inspectModel() ? 'installed' : 'missing'}); }
    catch (error) { update({phase:'error',error:friendlyError(error)}); }
  },
  async install() {
    if (operation || payrollLocalAi.isBusy()) { update({error:'Qwen est déjà utilisé. Attendez la fin de la lecture ou de la réponse.'}); return; }
    const current = ++generation;
    remember('enabled'); update({phase:'installing',label:'Préparation du téléchargement…',percent:null,error:'',deferred:false});
    const unsubscribe = payrollLocalAi.onProgress(progress=>update({label:progress.label,percent:progress.percent}));
    operation = (async()=>{
      try {
        await payrollLocalAi.load();
        if (current === generation) update({phase:'installed',label:'Qwen est prêt sur cet appareil.',percent:100});
      } catch (error) { if (current === generation) update({phase:'error',error:friendlyError(error)}); }
      finally { unsubscribe(); operation=null; }
    })();
    return operation;
  },
  cancel() { if (state.phase !== 'installing') return; generation++; payrollLocalAi.cancel(); update({phase:'missing',label:'Téléchargement annulé. Vous pouvez le reprendre.',percent:null,error:''}); },
  later() { remember('later'); update({deferred:true}); },
  async remove() {
    if (operation || payrollLocalAi.isBusy()) { update({error:'Attendez la fin de la lecture ou de la réponse avant de retirer Qwen.'}); return; }
    update({phase:'removing',error:''});
    operation=(async()=>{
      try { await payrollLocalAi.removeModel(); remember('later'); update({phase:'missing',deferred:true,label:'Qwen a été retiré de cet appareil.'}); }
      catch(error) { update({phase:'error',error:friendlyError(error)}); }
      finally { operation=null; }
    })();
    return operation;
  },
};
