import { useContext, useEffect, useSyncExternalStore } from 'react';
import { Check, Download, LoaderCircle, MessageCircle, Trash2 } from 'lucide-react';
import { localModelInstallation } from './localModelInstallation';
import { AssistantContext } from './assistantContext';

export function LocalAssistantSetup({ onboarding = false }: { onboarding?: boolean }) {
  const model = useSyncExternalStore(localModelInstallation.subscribe,localModelInstallation.getSnapshot);
  const assistant = useContext(AssistantContext);
  useEffect(()=>{ void localModelInstallation.inspect(); },[]);
  const busy = ['checking','installing','removing'].includes(model.phase);
  return <section className="local-assistant-setup" aria-label="Installation de l’assistant local">
    <div className="local-assistant-setup__heading"><span><MessageCircle size={23}/></span><div><p className="eyebrow">Une aide à vos côtés</p><h3>{onboarding ? 'Voulez-vous installer votre assistant local ?' : 'Assistant local · Qwen'}</h3></div></div>
    <p>Posez vos questions sur Zentra, comprenez une fiche de salaire ou faites-vous guider dans les réglages.</p>
    <p className="local-assistant-setup__privacy">Qwen · environ 429 Mo à télécharger une fois. Vos questions et le contexte restent sur cet appareil. Après installation, les réponses fonctionnent sans Internet. La rapidité dépend de votre appareil.</p>
    {model.phase === 'installed' ? <p className="local-assistant-setup__ready" role="status"><Check size={17}/> Installé sur cet appareil</p> : null}
    {model.phase === 'installing' ? <div role="status"><p>{model.label}</p><progress aria-label="Installation de Qwen" max={100} value={model.percent ?? undefined}/>{model.percent !== null && <span>{Math.round(model.percent)} %</span>}</div> : null}
    {model.error ? <p className="assistant-error" role="alert">{model.error}</p> : null}
    <div className="local-assistant-setup__actions">
      {model.phase === 'installed' ? <><button type="button" className="button button--primary" onClick={assistant?.open}><MessageCircle size={17}/> Poser une question</button><button type="button" className="button button--secondary" onClick={()=>void localModelInstallation.remove()}><Trash2 size={16}/> Désinstaller Qwen</button></> : <button type="button" className="button button--primary" disabled={busy} onClick={()=>void localModelInstallation.install()}>{busy ? <LoaderCircle className="spin" size={17}/> : <Download size={17}/>} {model.phase === 'checking' ? 'Vérification…' : model.phase === 'installing' ? 'Installation…' : model.phase === 'removing' ? 'Suppression…' : 'Installer Qwen · 429 Mo'}</button>}
      {model.phase === 'installing' ? <button type="button" className="button button--secondary" onClick={()=>localModelInstallation.cancel()}>Annuler le téléchargement</button> : onboarding && model.phase !== 'installed' && <button type="button" className="button button--secondary" disabled={busy} onClick={()=>localModelInstallation.later()}>{model.deferred ? 'Choix enregistré : plus tard' : 'Plus tard'}</button>}
    </div>
    {onboarding && <small>L’installation est facultative. Vous pouvez continuer la configuration et retrouver ce choix dans Paramètres → Assistant local.</small>}
    <small>Le même modèle sert à la lecture des fiches importées. Retirer Qwen conserve vos documents et vos données. Les échanges de l’assistant ne sont pas enregistrés sur disque.</small>
  </section>;
}
