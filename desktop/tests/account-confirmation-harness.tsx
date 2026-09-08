import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmAccountAction } from '../../components/confirm-account-action';

document.documentElement.style.setProperty('--font-geist-sans', 'Arial, sans-serif');
const styles = import.meta.glob('../../dist/client/_next/static/css/*.css', { query: '?url', eager: true, import: 'default', exhaustive: true });
for (const href of Object.values(styles)) {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = String(href); document.head.append(link);
}
function Fixture() {
  const [open,setOpen]=useState(false);
  const [calls,setCalls]=useState(0);
  const [error,setError]=useState('');
  return <main className="min-h-screen bg-[#f6f4ee] p-6 text-[#173d2c]">
    <h1 className="text-3xl font-semibold">Compte de démonstration</h1>
    <button type="button" className="mt-6 min-h-12 rounded-full bg-white px-6" onClick={()=>{setError('');setOpen(true);}}>Déconnecter le poste fictif</button>
    <p className="mt-4">Demandes confirmées : {calls}</p>
    <ConfirmAccountAction open={open} title="Déconnecter cet appareil ?"
      description="L’accès serveur du poste …04442fd5 (compte-fictif@example.invalid) sera coupé et les prochains renouvellements de sa licence seront bloqués. Ses données locales restent sur l’appareil."
      busy={false} error={error} onCancel={()=>setOpen(false)}
      onConfirm={()=>{ setCalls(calls+1); if(new URLSearchParams(location.search).has('error')) setError('Le service est momentanément indisponible. Réessayez.'); else setOpen(false); }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

