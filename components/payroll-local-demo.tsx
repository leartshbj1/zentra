'use client';

import {
  ArrowRight,
  Check,
  Cpu,
  Eye,
  FileDown,
  FileText,
  ScanLine,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

const steps = [
  {
    title: 'Documents',
    short: 'PDF multipages + images',
    icon: FileText,
  },
  {
    title: 'Lecture locale',
    short: 'Texte + IA locale',
    icon: ScanLine,
  },
  {
    title: 'Contrôle',
    short: 'Comparaison obligatoire',
    icon: Eye,
  },
  {
    title: 'Création',
    short: 'Fiche à contrôler',
    icon: UserCheck,
  },
] as const;

const detectedLines = [
  ['Salaire mensuel', '+ 6 500.00'],
  ['AVS / AI / APG', '− 344.50'],
  ['Assurance-chômage', '− 71.50'],
  ['Net détecté', '6 084.00'],
] as const;

export function PayrollLocalDemo() {
  const [active, setActive] = useState(0);
  const baseId = 'elyko-payroll-demo';

  return (
    <div className="overflow-hidden rounded-[28px] border border-[#cfd8d1] bg-[#edf2ee] shadow-[0_30px_80px_rgba(23,61,44,.13)]">
      <div className="border-b border-[#d9dfda] bg-white px-4 py-3 sm:px-6">
        <div
          className="horizontal-rail -mx-2 flex snap-x gap-2 overflow-x-auto px-2 sm:grid sm:grid-cols-4 sm:overflow-visible"
          role="tablist"
          aria-orientation="horizontal"
          aria-label="Exemple du parcours d’import de salaires"
        >
          {steps.map(({ title, short, icon: Icon }, index) => (
            <button
              key={title}
              id={`${baseId}-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={active === index}
              aria-controls={`${baseId}-panel`}
              tabIndex={active === index ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(event) => {
                const direction =
                  event.key === 'ArrowRight' || event.key === 'ArrowDown'
                    ? 1
                    : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                      ? -1
                      : 0;
                const requested =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? steps.length - 1
                      : direction
                        ? (index + direction + steps.length) % steps.length
                        : null;
                if (requested === null) return;
                event.preventDefault();
                setActive(requested);
                document.getElementById(`${baseId}-tab-${requested}`)?.focus();
              }}
              className={cn(
                'min-w-[168px] snap-start rounded-xl border px-3 py-2.5 text-left transition sm:min-w-0',
                active === index
                  ? 'border-[#315f47] bg-[#173d2c] text-white shadow-sm'
                  : 'border-[#e1e5e2] bg-[#fafbf9] text-[#536159] hover:border-[#b8c5bc]',
              )}
            >
              <span className="flex items-center gap-2 text-[11px] font-semibold">
                <Icon className="size-3.5" /> {index + 1}. {title}
              </span>
              <span
                className={cn(
                  'mt-1 block text-[11px] leading-4',
                  active === index ? 'text-white/82' : 'text-[#5d6b63]',
                )}
              >
                {short}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-w-0 gap-0 lg:grid-cols-[.82fr_1.18fr]">
        <div className="min-w-0 border-b border-[#d9dfda] bg-[#173d2c] p-5 text-white sm:p-7 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-full bg-white/8 px-3 py-1.5 text-[11px] font-semibold leading-4 text-white/82">
              <ShieldCheck className="size-3.5 text-[#7fd399]" /> Traitement sur ce PC
            </span>
            <span className="max-w-full whitespace-normal rounded-full bg-[#efaa3c] px-2.5 py-1 text-center text-[11px] font-bold leading-4 text-[#173d2c]">
              EXEMPLE FICTIF
            </span>
          </div>
          <div className="mt-7 rounded-2xl bg-white p-5 text-[#24372c] shadow-xl sm:p-6">
            <div className="flex items-start justify-between border-b border-[#e6eae7] pb-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[.11em] text-[#617068]">
                  Fiche source importée
                </p>
                <p className="mt-1.5 text-sm font-semibold">Août 2026</p>
              </div>
              <FileText className="size-5 text-[#b77726]" />
            </div>
            <div className="mt-5 space-y-3 text-[11px]">
              <div className="grid grid-cols-2 gap-3">
                <span className="rounded-lg bg-[#f3f5f3] p-2.5">Employeur exemple</span>
                <span className="rounded-lg bg-[#f3f5f3] p-2.5">Élodie Exemple</span>
              </div>
              {detectedLines.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b border-[#edf0ee] pb-2.5">
                  <span className="text-[#68756d]">{label}</span>
                  <strong className="font-semibold">{value} CHF</strong>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-5 text-xs leading-5 text-white/74">
            Les fichiers PDF et images sont copiés dans l’espace local Zentra. Aucun document de paie n’est envoyé, ni à Zentra ni au fournisseur du modèle.
          </p>
        </div>

        <div
          id={`${baseId}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${active}`}
          tabIndex={0}
          className="min-w-0 p-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#315f47] sm:p-7"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.11em] text-[#80521b]">
                Étape {active + 1} sur 4
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-[-.04em] text-[#24372c]">
                {[
                  'Ajoutez plusieurs fiches en une seule fois.',
                  'Zentra propose les champs localement.',
                  'Comparez toujours avec le document.',
                  'Créez un modèle, pas une vérité automatique.',
                ][active]}
              </h3>
            </div>
            <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full bg-[#e3eee6] px-3 py-1.5 text-[11px] font-semibold leading-4 text-[#34694a]">
              <Cpu className="size-3.5" /> IA facultative
            </span>
          </div>

          <div className="mt-6 rounded-2xl border border-[#d7ded8] bg-white p-4 sm:p-5">
            {active === 0 && (
              <div className="space-y-2.5">
                {['fiche-elodie-aout-3-pages.pdf', 'fiche-luca-aout.jpg'].map((file) => (
                  <div key={file} className="flex items-center justify-between rounded-xl bg-[#f4f6f4] px-3 py-3 text-xs">
                    <span className="flex min-w-0 items-center gap-2 font-medium text-[#3f5147]">
                      <FileText className="size-4 shrink-0 text-[#a66b20]" />
                      <span className="truncate">{file}</span>
                    </span>
                    <Check className="size-4 shrink-0 text-[#3d7854]" />
                  </div>
                ))}
                <p className="rounded-xl bg-[#eef3ef] p-3 text-[11px] leading-5 text-[#506158]">
                  Les pages sont rendues sur le PC. Pour un PDF long, la couche
                  texte complète reste utilisée et Zentra indique clairement les
                  pages analysées visuellement.
                </p>
              </div>
            )}
            {active === 1 && (
              <div className="space-y-3 text-xs text-[#526159]">
                <div className="flex flex-wrap items-center justify-between gap-2"><span>Couche texte du PDF</span><strong className="text-[#376d4c]">Lue en premier</strong></div>
                <div className="flex flex-wrap items-center justify-between gap-2"><span>Pages rendues localement</span><strong>Comparées ensemble</strong></div>
                <div className="flex flex-wrap items-center justify-between gap-2"><span>SmolVLM local</span><strong>Prêt si nécessaire</strong></div>
                <div className="h-2 overflow-hidden rounded-full bg-[#e9eeea]"><span className="payroll-demo-progress block h-full w-[86%] rounded-full bg-gradient-to-r from-[#2c6748] to-[#81a98a]" /></div>
                <p className="rounded-xl bg-[#fff4e4] p-3 leading-5 text-[#76511f]">Les propositions peuvent être inexactes : elles ne sont jamais validées automatiquement.</p>
              </div>
            )}
            {active === 2 && (
                <div className="space-y-2.5 text-xs">
                  {detectedLines.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 rounded-xl border border-[#e4e8e5] px-3 py-2.5">
                    <span className="flex items-center gap-2 text-[#546159]"><Check className="size-3.5 text-[#3e7b55]" /> {label}</span>
                    <strong className="text-[#31453a]">{value}</strong>
                  </div>
                ))}
                <div className="mt-3 flex items-start gap-2.5 rounded-xl bg-[#e9f2eb] p-3 leading-5 text-[#365b46]">
                  <span aria-hidden="true" className="mt-0.5 grid size-4 shrink-0 place-items-center rounded border border-[#4e815f] bg-[#4e815f] text-white"><Check className="size-3" /></span>
                  J’ai comparé les montants au document original.
                </div>
              </div>
            )}
            {active === 3 && (
              <div>
                <div className="flex items-center justify-between rounded-xl bg-[#e9f2eb] p-4">
                  <div>
                    <p className="text-[11px] text-[#536b5f]">Résultat dans Zentra</p>
                    <strong className="mt-1 block text-sm text-[#2e523e]">Fiche d’août · À contrôler</strong>
                  </div>
                  <Check className="size-5 text-[#3e7b55]" />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <span className="rounded-xl border border-[#dfe5e0] p-3 text-[11px] leading-4 text-[#4f5e56]">Collaborateur rapproché</span>
                  <span className="rounded-xl border border-[#dfe5e0] p-3 text-[11px] leading-4 text-[#4f5e56]">Lignes récurrentes proposées</span>
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-md text-[11px] leading-5 text-[#707c75]">
              SmolVLM est téléchargé au premier usage, puis exécuté localement. La comparaison humaine reste obligatoire avant création.
            </p>
            {active < steps.length - 1 ? (
              <button
                type="button"
                onClick={() => setActive((value) => value + 1)}
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-xs font-semibold text-white transition hover:bg-[#24563f]"
              >
                Étape suivante <ArrowRight className="size-3.5" />
              </button>
            ) : (
              <a
                href="/downloads/exemple-fiche-salaire-zentra.pdf"
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#e79b2f] px-5 text-xs font-semibold text-[#203127] transition hover:bg-[#efaa3c]"
              >
                Voir le PDF exemple <FileDown className="size-3.5" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
