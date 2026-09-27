// Isolated UI fixture: no company data, native commands or remote requests.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { CompanySyncIndicator, CompanySyncPanel, publishCompanySync } from '../src/companySync';
import { setAppLanguage, parseLanguage } from '../src/language';
import { setAppearance } from '../src/appearance';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
const query=new URLSearchParams(location.search);
await setAppLanguage(parseLanguage(query.get('language'))||'fr');
setAppearance(query.get('theme')==='dark'?'dark':'light');
Object.assign(window,{syncHealth:{publish:publishCompanySync}});
function Harness(){
  const [open,setOpen]=useState(false);
  return <main className="desktop-app cloud-account-panel" style={{display:'block',minHeight:'100vh',maxWidth:760,margin:'auto',padding:20}}>
    <h1>Zentra · Atelier de démonstration</h1>
    <CompanySyncIndicator organizationId="company-a" onOpen={()=>setOpen(true)}/>
    {open&&<CompanySyncPanel/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
