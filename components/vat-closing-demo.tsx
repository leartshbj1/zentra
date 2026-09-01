'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  FileCheck2,
  FileDown,
  LockKeyhole,
  ShieldAlert,
} from 'lucide-react';

const stages = [
  {
    id: 'preparer',
    label: '1. Préparer',
    eyebrow: 'Aperçu contrôlable',
    title: 'Elyko demande une décision au lieu de deviner.',
    text: 'Chaque vente, achat ou dépense pertinente reçoit un traitement TVA explicite. Une source ambiguë reste visible et bloque l’export tant qu’elle n’est pas classée.',
    icon: ShieldAlert,
    facts: [
      ['Profil', 'Méthode et périodicité datées'],
      ['Sources', 'Classées une par une'],
      ['Résultat', 'Export bloqué si incomplet'],
    ],
  },
  {
    id: 'exporter',
    label: '2. Exporter',
    eyebrow: 'eCH-0217 v2.0.0',
    title: 'Un XML local prêt pour votre contrôle.',
    text: 'Elyko calcule en centimes, produit le fichier XML et son empreinte SHA-256. Vous l’importez manuellement dans Décompte TVA pro, puis vous vérifiez, complétez et soumettez dans le Portail AFC.',
    icon: FileDown,
    facts: [
      ['Fichier', 'XML UTF-8 sans BOM'],
      ['Intégrité', 'Empreinte SHA-256'],
      ['Transmission', 'Jamais automatique'],
    ],
  },
  {
    id: 'cloturer',
    label: '3. Clôturer',
    eyebrow: 'Revue en deux temps',
    title: 'La période n’est verrouillée qu’après les contrôles.',
    text: 'Journal, bilan, continuité, chaîne d’audit et pièces sont revérifiés. Elyko produit ensuite un dossier fiduciaire DRAFT ou FINAL avec manifeste, sommes de contrôle et historique lisible.',
    icon: LockKeyhole,
    facts: [
      ['Avant', 'Pré-clôture révisable'],
      ['Confirmation', 'Nom exact de la période'],
      ['Archive', 'ZIP DRAFT ou FINAL'],
    ],
  },
] as const;

export function VatClosingDemo() {
  const [activeId, setActiveId] = useState<(typeof stages)[number]['id']>(
    'preparer',
  );
  const active = stages.find((stage) => stage.id === activeId) ?? stages[0];
  const ActiveIcon = active.icon;

  return (
    <div className="overflow-hidden rounded-[28px] border border-[#cbd8ce] bg-white/80 shadow-[0_24px_70px_rgba(28,65,43,.1)]">
      <div
        className="grid gap-2 border-b border-[#d8dfda] bg-[#f4f8f5] p-3 sm:grid-cols-3"
        role="tablist"
        aria-label="Parcours TVA et clôture"
      >
        {stages.map((stage) => (
          <button
            key={stage.id}
            type="button"
            role="tab"
            aria-selected={activeId === stage.id}
            onClick={() => setActiveId(stage.id)}
            className={`min-h-11 rounded-2xl px-4 py-3 text-left text-sm font-semibold transition ${
              activeId === stage.id
                ? 'bg-[#173d2c] text-white shadow-sm'
                : 'text-[#496055] hover:bg-white hover:text-[#173d2c]'
            }`}
          >
            {stage.label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[1fr_.9fr] lg:items-stretch">
        <div className="flex flex-col">
          <span className="grid size-11 place-items-center rounded-2xl bg-[#e7a33a]/18 text-[#9a651f]">
            <ActiveIcon className="size-5" aria-hidden="true" />
          </span>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[.13em] text-[#467156]">
            {active.eyebrow}
          </p>
          <h3 className="mt-3 text-2xl font-semibold leading-tight tracking-[-.035em] text-[#203d2d] sm:text-3xl">
            {active.title}
          </h3>
          <p className="mt-4 max-w-xl text-sm leading-7 text-[#607068]">
            {active.text}
          </p>
          <p className="mt-auto pt-7 text-xs leading-5 text-[#7a817c]">
            Visite guidée du flux. Aucun chiffre fiscal ni dossier n’est créé sur
            ce site.
          </p>
        </div>

        <div className="rounded-[22px] border border-[#d8ddd8] bg-[#fbfaf6] p-5 sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[.12em] text-[#7b867f]">
                Contrôle local
              </span>
              <strong className="mt-1 block text-sm text-[#294735]">
                {active.label}
              </strong>
            </div>
            <FileCheck2 className="size-5 text-[#4f8b62]" aria-hidden="true" />
          </div>
          <dl className="mt-6 grid gap-3">
            {active.facts.map(([label, value]) => (
              <div
                key={label}
                className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-[#e0e1dc] bg-white px-4 py-3"
              >
                <dt className="text-xs text-[#748078]">{label}</dt>
                <dd className="flex items-center gap-2 text-right text-xs font-semibold text-[#294735]">
                  <CheckCircle2 className="size-4 shrink-0 text-[#4f9b68]" />
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
