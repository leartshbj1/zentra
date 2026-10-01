// Synthetic browser recipe; this entry is excluded from the production build.
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {X} from 'lucide-react';
import {DiagnosticsPanel} from '../src/DiagnosticsPanel';
import {ErrorGuidance} from '../src/ErrorGuidance';
import {diagnosticsApi} from '../src/diagnostics';
import {setAppLanguage,t,type AppLanguage} from '../src/language';
import {setAppearance} from '../src/appearance';
import {setTextSize,type TextSize} from '../src/textSize';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/refined.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
import '../src/apple-workspace.css';
import '../src/apple-business.css';
const query=new URLSearchParams(location.search);
await setAppLanguage((query.get('language')||'fr') as AppLanguage);
setAppearance(query.get('theme')==='dark'?'dark':'light');
setTextSize(Number(query.get('text')||100) as TextSize);
const incident={id:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002',timestamp:new Date().toISOString(),area:'command' as const,operation:'sync_company_workspace',phase:'failure' as const,errorCode:'NETWORK'};
diagnosticsApi.summary=async()=>({sessionId:incident.sessionId,appVersion:'test',platform:'synthetic',eventCount:60,fileCount:1,sizeBytes:40000,maxFileBytes:2097152,maxFiles:3,firstEventAt:incident.timestamp,lastEventAt:incident.timestamp,lastIncident:incident});
diagnosticsApi.export=async()=>'/synthetic/exports/diagnostic.jsonl';
diagnosticsApi.clear=async()=>{};
function Preview(){const [reads,setReads]=useState(0);return <main className="desktop-app" style={{padding:20,maxWidth:1100,margin:'auto'}}><DiagnosticsPanel/><section style={{marginTop:24}} data-error-preview><ErrorGuidance error="network timeout https://api.example.invalid?token=private customer@example.ch" operation="read" onReload={()=>setReads(value=>value+1)}/><p data-read-count>{reads}</p></section><section style={{marginTop:24}} data-mutation-preview><ErrorGuidance error="Champ invalide : le fournisseur est obligatoire." operation="mutation"/></section></main>;}
// The notice subtree mirrors WorkspaceApp; query toast is confined to this recipe.
function ToastPreview(){const [visible,setVisible]=useState(true);return <main className="desktop-app" data-experience="clarity">
  {visible ? <div className="notice notice--error notice--floating" role="alert" aria-live="assertive">
    <ErrorGuidance error="network timeout https://api.example.invalid?token=private customer@example.ch" compact />
    <button type="button" onClick={()=>setVisible(false)} aria-label={t('Fermer le message')}><X size={15}/></button>
  </div> : null}
</main>;}
createRoot(document.getElementById('root')!).render(query.has('toast')?<ToastPreview/>:<Preview/>);
