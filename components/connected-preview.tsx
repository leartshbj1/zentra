'use client';

import { useEffect, useState } from 'react';
import { Check, FileText, CalendarDays, MessageSquare } from 'lucide-react';

const scenes = [
  { name: 'Une facture', Icon: FileText, received: 'Facture fournisseur reçue', prepared: 'Informations extraites', result: 'Votre achat est préparé', screen: 'achats', target: 'Gestion · Achats' },
  { name: 'Un rendez-vous', Icon: CalendarDays, received: 'Rendez-vous confirmé', prepared: 'Date et lieu reconnus', result: 'Votre agenda est complété', screen: 'agenda', target: 'Gestion · Agenda' },
  { name: 'Une demande', Icon: MessageSquare, received: 'Demande client reçue', prepared: 'Catégorie et priorité proposées', result: 'La bonne équipe est choisie', screen: 'automation', target: 'Support · Demandes' },
] as const;

export function ConnectedPreview({ interactive = false }: { interactive?: boolean }) {
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(2);
  const [replay, setReplay] = useState(0);
  const scene = scenes[selected];
  const Icon = scene.Icon;
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = requestAnimationFrame(() => setStep(reducedMotion ? 2 : 0));
    if (reducedMotion) return () => cancelAnimationFrame(start);
    const preparation = window.setTimeout(() => setStep(1), 950);
    const arrival = window.setTimeout(() => setStep(2), 1900);
    return () => { cancelAnimationFrame(start); clearTimeout(preparation); clearTimeout(arrival); };
  }, [selected, replay]);
  return (
    <div className={`connected-preview${interactive ? ' connected-preview-interactive' : ''}`}>
      {interactive && <fieldset className="connected-scenes" aria-label="Choisir un parcours">
        {scenes.map((item, index) => <button key={item.name} type="button" aria-pressed={selected === index} onClick={() => { setSelected(index); setReplay(value => value + 1); }}>{item.name}</button>)}
      </fieldset>}
      <div className="connected-stage">
        <picture className="connected-screen">
          <source media="(max-width: 600px)" srcSet={`/tour/gestion/${scene.screen}-mobile.webp`} />
          <img src={`/tour/gestion/${scene.screen}-desktop.webp`} width={1440} height={960}
            alt={`Capture de démonstration de ${scene.target}`} fetchPriority={interactive ? undefined : 'high'} />
        </picture>
        <div className="connected-document" data-step={step}>
          <span className="connected-document-icon">{step === 2 ? <Check size={23} aria-hidden="true" /> : <Icon size={23} aria-hidden="true" />}</span>
          <div><strong>{step === 0 ? scene.received : step === 1 ? scene.prepared : scene.result}</strong>
            <span>{step === 0 ? 'Support' : step === 1 ? 'Automation' : scene.target}</span>
          </div>
        </div>
      </div>
      <div className="connected-caption">
        <span>Simulation · données fictives</span>
        {interactive && <button type="button" onClick={() => setReplay(value => value + 1)}>Revoir le parcours</button>}
      </div>
      {interactive && <p className="quiet-note">Avec Gestion, Support et Automation reliés. Les traitements suivent vos connexions et vos règles ; les cas incertains restent à vérifier.</p>}
    </div>
  );
}
