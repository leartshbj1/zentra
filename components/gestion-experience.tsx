'use client';

import { useState } from 'react';
import { ArrowRight, Check, FileText } from 'lucide-react';

const stages = [
  {
    name: 'Le devis',
    title: 'Une proposition qui vous ressemble.',
    text: 'Vos prestations, votre logo et vos conditions. Préparez un document clair, prêt à présenter à votre client.',
    kind: 'Devis',
    reference: 'DV-2026-0042',
    status: 'Accepté',
    next: 'Puis, la facture',
    note: 'Votre proposition reste liée au dossier du client.',
  },
  {
    name: 'La facture',
    title: 'La suite est déjà là.',
    text: 'Reprenez le devis accepté pour préparer votre facture. Les informations du client et les prestations vous accompagnent.',
    kind: 'Facture',
    reference: 'FA-2026-0058',
    status: 'Émise',
    next: 'Puis, le paiement',
    note: 'Le devis et la facture se retrouvent dans le même projet.',
  },
  {
    name: 'Le paiement',
    title: 'Vous savez où vous en êtes.',
    text: 'Enregistrez l’encaissement. Le solde de la facture évolue et votre équipe retrouve la même information dans l’entreprise partagée.',
    kind: 'Facture',
    reference: 'FA-2026-0058',
    status: 'Payée',
    next: 'Revoir le parcours',
    note: 'Un encaissement enregistré, un solde mis à jour.',
  },
] as const;

export function GestionExperience() {
  const [index, setIndex] = useState(0);
  const stage = stages[index];
  return (
    <section
      className="gestion-experience page-width"
      id="workflow"
      aria-labelledby="gestion-journey-title"
    >
      <div className="gestion-journey-copy">
        <h2 id="gestion-journey-title">
          Du premier devis.
          <br />
          <span>Au dernier paiement.</span>
        </h2>
        <fieldset
          className="journey-choices"
          aria-label="Explorer le parcours de facturation"
        >
          {stages.map((item, i) => (
            <button
              key={item.name}
              type="button"
              aria-pressed={index === i}
              onClick={() => setIndex(i)}
            >
              {item.name}
            </button>
          ))}
        </fieldset>
        <div
          className="journey-explanation"
          aria-live="polite"
          aria-atomic="true"
        >
          <h3>{stage.title}</h3>
          <p>{stage.text}</p>
        </div>
        <a className="page-text-link" href="/demo-facture#factures">
          Voir les factures dans l’app <ArrowRight size={17} aria-hidden="true" />
        </a>
      </div>
      <div className="gestion-document-stage">
        <p className="journey-demo-label">
          Exemple interactif · données fictives
        </p>
        <div className="gestion-document" key={index}>
          <div className="gestion-document-heading">
            <FileText size={26} strokeWidth={1.5} aria-hidden="true" />
            <span>{stage.status}</span>
          </div>
          <h3>
            {stage.kind}
            <span>{stage.reference}</span>
          </h3>
          <div className="gestion-document-client">
            <span>Pour</span>
            <strong>Atelier Léman</strong>
            <span>Projet · Aménagement des bureaux</span>
          </div>
          <div className="gestion-document-line">
            <span>Prestations convenues</span>
            <strong>CHF 1’000.00</strong>
          </div>
          <div className="gestion-document-line">
            <span>TVA 8,1 %</span>
            <span>CHF 81.00</span>
          </div>
          <div className="gestion-document-total">
            <span>Total</span>
            <strong>CHF 1’081.00</strong>
          </div>
          {index === 2 && (
            <p className="journey-paid">
              <Check size={16} aria-hidden="true" /> Solde restant : CHF 0.00
            </p>
          )}
        </div>
        <p className="journey-document-note">{stage.note}</p>
        <button
          className="journey-next"
          type="button"
          onClick={() => setIndex((index + 1) % stages.length)}
        >
          {stage.next}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
