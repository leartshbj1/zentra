import {useEffect,useRef,useState} from 'react';
import {Download,RefreshCw,Trash2,Copy} from 'lucide-react';
import {diagnosticsApi,resolveErrorIncident,type DiagnosticsSummary} from './diagnostics';
import {useAppLanguage,type AppLanguage} from './language';
import {desktopApi} from './bridge';
import {isMobileRuntime,shareMobileExport} from './mobileRuntime';
import {Button,SectionHeading} from './ui';
import {ErrorGuidance} from './ErrorGuidance';
import './diagnostics.css';
const copy:Record<AppLanguage,Record<string,string>>={
  fr:{title:'Diagnostic',intro:'Un journal local pour comprendre et corriger les problèmes.',export:'Exporter le diagnostic',clear:'Effacer le journal',refresh:'Actualiser',events:'événements',empty:'Aucun incident récent.',incident:'Dernier incident',copy:'Copier la référence',loading:'Lecture du journal…',failed:'Le journal ne peut pas être lu pour le moment.',exported:'Diagnostic exporté.',folder:'Ouvrir le dossier',confirm:'Effacer les événements de diagnostic ?',cancel:'Annuler',cleared:'Journal effacé.',privacy:'Les journaux contiennent les actions et leurs résultats, sans contenu de document, mot de passe ni clé.',copyFail:'La référence ne peut pas être copiée. Vous pouvez la sélectionner ci-dessous.',copied:'Référence copiée.',exportFailed:'Le diagnostic n’a pas pu être exporté.',clearFailed:'L’effacement du journal n’a pas pu être confirmé.',share:'Partager le diagnostic',shareFailed:'Le diagnostic est créé, mais son partage n’a pas abouti.'},
  de:{title:'Diagnose',intro:'Ein lokales Protokoll zum Verstehen und Beheben von Problemen.',export:'Diagnose exportieren',clear:'Protokoll löschen',refresh:'Aktualisieren',events:'Ereignisse',empty:'Keine kürzlich erfassten Vorfälle.',incident:'Letzter Vorfall',copy:'Referenz kopieren',loading:'Protokoll wird gelesen…',failed:'Das Protokoll kann derzeit nicht gelesen werden.',exported:'Diagnose exportiert.',folder:'Ordner öffnen',confirm:'Diagnoseereignisse löschen?',cancel:'Abbrechen',cleared:'Protokoll gelöscht.',privacy:'Protokolle enthalten Aktionen und Ergebnisse, aber keine Dokumentinhalte, Passwörter oder Schlüssel.',copyFail:'Die Referenz konnte nicht kopiert werden. Sie können sie unten auswählen.',copied:'Referenz kopiert.',exportFailed:'Die Diagnose konnte nicht exportiert werden.',clearFailed:'Das Löschen des Protokolls konnte nicht bestätigt werden.',share:'Diagnose teilen',shareFailed:'Die Diagnose wurde erstellt, konnte aber nicht geteilt werden.'},
  it:{title:'Diagnostica',intro:'Un registro locale per capire e correggere i problemi.',export:'Esporta diagnostica',clear:'Cancella registro',refresh:'Aggiorna',events:'eventi',empty:'Nessun incidente recente.',incident:'Ultimo incidente',copy:'Copia riferimento',loading:'Lettura del registro…',failed:'Il registro non può essere letto al momento.',exported:'Diagnostica esportata.',folder:'Apri cartella',confirm:'Cancellare gli eventi di diagnostica?',cancel:'Annulla',cleared:'Registro cancellato.',privacy:'I registri contengono azioni e risultati, senza contenuto dei documenti, password o chiavi.',copyFail:'Il riferimento non può essere copiato. Puoi selezionarlo qui sotto.',copied:'Riferimento copiato.',exportFailed:'La diagnostica non ha potuto essere esportata.',clearFailed:'La cancellazione del registro non ha potuto essere confermata.',share:'Condividi diagnostica',shareFailed:'La diagnostica è stata creata, ma la condivisione non è riuscita.'},
  en:{title:'Diagnostics',intro:'A local log to understand and fix problems.',export:'Export diagnostics',clear:'Clear log',refresh:'Refresh',events:'events',empty:'No recent incidents.',incident:'Latest incident',copy:'Copy reference',loading:'Reading the log…',failed:'The log cannot be read right now.',exported:'Diagnostics exported.',folder:'Open folder',confirm:'Clear diagnostic events?',cancel:'Cancel',cleared:'Log cleared.',privacy:'Logs contain actions and outcomes, without document contents, passwords or keys.',copyFail:'The reference could not be copied. You can select it below.',copied:'Reference copied.',exportFailed:'Diagnostics could not be exported.',clearFailed:'Clearing the log could not be confirmed.',share:'Share diagnostics',shareFailed:'Diagnostics were created, but sharing did not complete.'},
};
export function DiagnosticsPanel(){
  const lang=useAppLanguage(),c=copy[lang];
  const [summary,setSummary]=useState<DiagnosticsSummary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[notice,setNotice]=useState(''),[path,setPath]=useState(''),[confirm,setConfirm]=useState(false);
  const flight=useRef(false),revision=useRef(0);
  const [errorContext,setErrorContext]=useState({operation:'read' as 'read'|'mutation',fallbackKey:'failed'});
  async function refresh(){
    if(flight.current)return;flight.current=true;const ticket=++revision.current;setBusy(true);setError(null);setErrorContext({operation:'read',fallbackKey:'failed'});
    try{const value=await diagnosticsApi.summary();if(ticket===revision.current)setSummary(value);}catch(reason){if(ticket===revision.current)setError(reason);}finally{flight.current=false;setBusy(false);}
  }
  useEffect(()=>{let active=true;const ticket=++revision.current;diagnosticsApi.summary().then(value=>{if(active&&ticket===revision.current)setSummary(value);},reason=>{if(active&&ticket===revision.current)setError(reason);});return()=>{active=false;};},[]);
  async function action(kind:'export'|'clear'){
    if(flight.current||(kind==='clear'&&!confirm))return;flight.current=true;++revision.current;setBusy(true);setError(null);setNotice('');
    let recorded=false,created=false;
    try{if(kind==='export'){const file=await diagnosticsApi.export();created=true;setPath(file);if(isMobileRuntime())await shareMobileExport(file);recorded=true;setNotice('exported');}else{await diagnosticsApi.clear();recorded=true;setConfirm(false);setPath('');setNotice('cleared');}setSummary(await diagnosticsApi.summary());}
    catch(reason){setErrorContext({operation:recorded?'read':'mutation',fallbackKey:recorded?'failed':created?'shareFailed':kind==='export'?'exportFailed':'clearFailed'});setError(reason);}finally{flight.current=false;setBusy(false);}
  }
  async function copyReference(){try{if(!navigator.clipboard?.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(incident);setNotice('copied');}catch{setNotice('copyFail');}}
  async function shareExport(){if(flight.current||!path)return;flight.current=true;setBusy(true);setError(null);try{await shareMobileExport(path);setNotice('exported');}catch(reason){setErrorContext({operation:'mutation',fallbackKey:'shareFailed'});setError(reason);}finally{flight.current=false;setBusy(false);}}

  const incident=summary?.lastIncident?`ZT-${summary.lastIncident.id}`:'';
  return <section className="panel settings-card diagnostics-panel" data-diagnostics-panel>
    <SectionHeading title={c.title} description={c.intro}/>
    {summary?<div className="diagnostics-meta"><span>Zentra {summary.appVersion} · {summary.platform}</span><span>{summary.eventCount} {c.events} · {(summary.sizeBytes/1024).toFixed(0)} Ko</span></div>:!error?<p role="status">{c.loading}</p>:null}
    {error?<ErrorGuidance title={c.title} error={error} fallback={c[errorContext.fallbackKey]} operation={errorContext.operation} onReload={()=>void refresh()} disabled={busy}/>:null}
    <p className="diagnostics-incident">{incident?<><strong>{c.incident}</strong><code>{incident}</code><Button size="small" variant="ghost" disabled={busy} onClick={()=>void copyReference()}><Copy size={15}/>{c.copy}</Button></>:c.empty}</p>
    <div className="settings-actions"><Button variant="secondary" disabled={busy||!summary} onClick={()=>void action('export')}><Download size={16}/>{c.export}</Button><Button variant="ghost" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={16}/>{c.refresh}</Button><Button variant="ghost" disabled={busy||!summary} onClick={()=>setConfirm(true)}><Trash2 size={16}/>{c.clear}</Button></div>
    {confirm?<div className="diagnostics-confirm" role="group" aria-label={c.confirm}><p>{c.confirm}</p><Button variant="danger" disabled={busy} onClick={()=>void action('clear')}>{c.clear}</Button><Button variant="ghost" disabled={busy} onClick={()=>setConfirm(false)}>{c.cancel}</Button></div>:null}
    {notice?<p role="status">{c[notice]}</p>:null}
    {path&&isMobileRuntime()?<Button variant="secondary" disabled={busy} onClick={()=>void shareExport()}>{c.share}</Button>:null}
    {path&&!isMobileRuntime()?<div className="diagnostics-export"><code>{path}</code><Button variant="ghost" disabled={busy} onClick={()=>{void desktopApi.openDataFolder().catch(reason=>{resolveErrorIncident(reason);setError(reason);});}}>{c.folder}</Button></div>:null}
    <p className="diagnostics-privacy">{c.privacy}</p>
  </section>;
}
