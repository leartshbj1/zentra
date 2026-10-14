import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutopilotCatalogueNext, AutopilotReviews } from '../src/AutopilotPanel';
import { CatalogItemForm } from '../src/CatalogItemForm';
import { FormDraftIdentityProvider } from '../src/useFormDraft';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { parseLanguage, setAppLanguage } from '../src/language';
import type { AutopilotView } from '../src/autopilotView';
import type { Workspace } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/apple-workspace.css';

const query=new URLSearchParams(location.search);
document.documentElement.dataset.appTheme=query.get('theme')==='dark'?'dark':'light';
await setAppLanguage(parseLanguage(query.get('language'))??'fr');
const workspace={workNotesScope:'preview-company',settings:structuredClone(initialOnboardingSettings),catalogItems:[],stockMovements:[]} as unknown as Workspace;
workspace.settings!.organization.vatRegistered=true;workspace.settings!.billing.vatRatesBp=[810,260,0];
const origin={workspaceScope:'preview-company',memberContextNonce:'a'.repeat(32)};
const request={organizationId:'preview-org',proposalId:'preview-proposal',sourceId:'preview-ticket',origin};
const state:AutopilotView={status:'ready',canManage:true,consent:null,saving:false,error:null,activity:null,readingReviews:false,reviewsUnavailable:false,
  reviews:{organizationId:'preview-org',nextCursor:null,items:[{proposalId:request.proposalId,sourceId:request.sourceId,createdAt:1791993600,
    disposition:'needs_review',reasons:['missing_article'],requiresHumanValidation:true}]}};
function Preview(){const [editor,setEditor]=useState(false),[message,setMessage]=useState('');return <>
  <header className="preview-note">Aperçu visuel · données fictives · aucun appel métier</header>
  <main className="desktop-app" data-experience="workspace"><h1>Automation</h1>
    <AutopilotReviews state={state} organizationId="preview-org" canAddCatalogue onOpenSource={async()=>setMessage('Aperçu : le message s’ouvre dans Support.')}
      onCatalogue={(_item,mode)=>mode==='create'?setEditor(true):setMessage('Aperçu : le catalogue de l’entreprise s’ouvre.')}/>
    <AutopilotCatalogueNext canWrite onWriteQuote={()=>setMessage('Aperçu : l’assistant de devis manuel s’ouvre.')}
      onReturnRequest={async()=>setMessage('Aperçu : le message d’origine s’ouvre dans Support.')} onDismiss={()=>setMessage('Aperçu : suite masquée.')}/>
    {message&&<p role="status">{message}</p>}
  </main>
  {editor&&<FormDraftIdentityProvider companyId="preview-company" organizationId="preview-org" memberId="preview-member" memberContextNonce={origin.memberContextNonce} ready>
    <CatalogItemForm workspace={workspace} busy={false} readOnly={false} close={()=>setEditor(false)} act={async()=>false}
      onReadWorkspace={async()=>workspace} autopilotRequest={request}/>
  </FormDraftIdentityProvider>}
  <style>{`*{box-sizing:border-box}body{margin:0;background:var(--apple-canvas);color:var(--apple-ink);font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.preview-note{padding:12px 20px;font-size:13px;color:var(--apple-secondary);border-bottom:1px solid var(--apple-line)}main.desktop-app{display:block!important;min-height:0!important;max-width:960px;margin:auto;padding:32px;background:var(--apple-canvas)}h1{font-size:30px;letter-spacing:-.025em;margin:0 0 24px}@media(max-width:680px){main.desktop-app{padding:20px 12px}h1{font-size:28px}.preview-note{padding:12px;font-size:12px}}`}</style>
  </>;}
function MobileHost(){const [language,setLanguage]=useState(query.get('language')??'fr'),[theme,setTheme]=useState(query.get('theme')??'light');
  const child=new URL(location.href);child.searchParams.delete('mobile');child.searchParams.set('language',language);child.searchParams.set('theme',theme);
  return <div style={{padding:16,display:'grid',justifyItems:'center',gap:16}}>
    <p>Aperçu des vrais composants · données fictives · aucun appel métier</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:12}}>
      <label>Langue <select value={language} onChange={event=>setLanguage(event.target.value)} style={{minHeight:44}}><option value="fr">Français</option><option value="de">Deutsch</option><option value="it">Italiano</option><option value="en">English</option></select></label>
      <label>Apparence <select value={theme} onChange={event=>setTheme(event.target.value)} style={{minHeight:44}}><option value="light">Claire</option><option value="dark">Sombre</option></select></label>
    </div>
    <iframe title="Zentra · aperçu mobile 390 × 844" src={child.href} width="390" height="844" style={{width:390,height:844,maxWidth:'100%',border:'1px solid var(--apple-line)',borderRadius:16}}/>
  </div>;
}
createRoot(document.getElementById('root')!).render(query.get('mobile')==='1'?<MobileHost/>:<Preview/>);
