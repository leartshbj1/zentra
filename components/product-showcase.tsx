'use client';

import {
  ArrowRight,
  BookOpenCheck,
  Calculator,
  Check,
  Cpu,
  FileCheck2,
  FileText,
  FolderKanban,
  LayoutDashboard,
  QrCode,
  Receipt,
  ScanLine,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/lib/utils';

const views = [
  { label: 'Pilotage', icon: LayoutDashboard },
  { label: 'Devis → facture', icon: FileCheck2 },
  { label: 'Projets', icon: FolderKanban },
  { label: 'Salaires', icon: Users },
  { label: 'Comptabilité', icon: BookOpenCheck },
] as const;

function DashboardView() {
  return (
    <div className="showcase-panel grid gap-3 lg:grid-cols-[1.15fr_.85fr]">
      <div className="rounded-2xl border border-[#dfe5e0] bg-white p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-[#2c4034]">
              Chiffre d’affaires encaissé
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-[-.04em] text-[#1c3125] sm:text-3xl">
              86 420 CHF
            </p>
          </div>
          <span className="rounded-full bg-[#e7f2e9] px-2.5 py-1 text-[10px] font-semibold text-[#34684a]">
            +12,4 %
          </span>
        </div>
        <div className="mt-7 flex h-28 items-end gap-2 sm:h-36">
          {[38, 51, 45, 64, 57, 76, 69, 90].map((value, index) => (
            <div key={index} className="flex h-full flex-1 items-end">
              <span
                className="showcase-bar block w-full rounded-t-md bg-[#2f694a]"
                style={{
                  height: `${value}%`,
                  animationDelay: `${index * 55}ms`,
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between text-[9px] text-[#929d96]">
          <span>Janvier</span>
          <span>Août</span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        {[
          ['À facturer', '18 450 CHF', '3 dossiers prêts'],
          ['Factures en retard', '2 180 CHF', '2 relances à préparer'],
          ['Heures enregistrées', '164 h', 'Ce mois-ci'],
        ].map(([label, value, detail]) => (
          <div
            key={label}
            className="rounded-2xl border border-[#dfe5e0] bg-white p-4"
          >
            <p className="text-[10px] font-medium text-[#77837c]">{label}</p>
            <p className="mt-2 text-lg font-semibold tracking-[-.03em] text-[#263b2e]">
              {value}
            </p>
            <p className="mt-1 text-[10px] text-[#aa6d21]">{detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DocumentsView() {
  return (
    <div className="showcase-panel grid gap-4 lg:grid-cols-[.86fr_1.14fr]">
      <div className="rounded-2xl bg-[#173d2c] p-5 text-white sm:p-6">
        <p className="text-[10px] font-semibold uppercase tracking-[.14em] text-[#efb157]">
          Flux sans double saisie
        </p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-.04em]">
          Un devis accepté devient une facture en un clic.
        </h3>
        <div className="mt-7 space-y-2.5">
          {[
            [FileCheck2, 'Devis DV-2026-0042', 'Accepté'],
            [Receipt, 'Facture FA-2026-0086', 'Créée'],
            [QrCode, 'Section paiement suisse', 'Ajoutée'],
            [BookOpenCheck, 'Écriture comptable', 'Équilibrée'],
          ].map(([Icon, label, status], index) => (
            <div
              key={label as string}
              className="relative flex items-center gap-3"
            >
              {index < 3 && (
                <span className="workflow-line absolute left-[17px] top-9 h-4 w-px bg-white/18" />
              )}
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/10 text-[#efb157]">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">
                  {label as string}
                </p>
                <p className="mt-0.5 text-[9px] text-white/45">
                  {status as string}
                </p>
              </div>
              <Check className="size-4 text-[#77cf92]" />
            </div>
          ))}
        </div>
        <div className="mt-7 inline-flex items-center gap-2 rounded-full bg-[#efaa3c] px-4 py-2 text-[10px] font-semibold text-[#173d2c]">
          Converti avec succès <ArrowRight className="size-3.5" />
        </div>
      </div>

      <div className="rounded-2xl border border-[#dfe5e0] bg-white p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4 border-b border-[#e7ebe8] pb-4">
          <div>
            <p className="text-lg font-semibold text-[#22372a]">FACTURE</p>
            <p className="mt-1 text-[10px] text-[#89948d]">FA-2026-0086</p>
          </div>
          <BrandMark className="size-8" />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 text-[9px] text-[#7d8881]">
          <div>
            <p className="font-semibold text-[#35483d]">Émetteur</p>
            <p className="mt-1 leading-4">
              Votre entreprise SA
              <br />
              1000 Lausanne
            </p>
          </div>
          <div>
            <p className="font-semibold text-[#35483d]">Client</p>
            <p className="mt-1 leading-4">
              Client exemple
              <br />
              1200 Genève
            </p>
          </div>
        </div>
        <div className="mt-6 space-y-2 text-[9px]">
          {[
            ['Prestation principale', '8 900.00'],
            ['Frais et matériel', '1 350.00'],
            ['TVA', '830.25'],
          ].map(([label, amount]) => (
            <div
              key={label}
              className="flex justify-between border-b border-[#edf0ee] pb-2"
            >
              <span className="text-[#66736b]">{label}</span>
              <span className="font-medium text-[#33473a]">{amount}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-end justify-between rounded-xl bg-[#f3f6f3] p-3">
          <div className="grid size-14 grid-cols-5 gap-px bg-white p-1 shadow-sm">
            {Array.from({ length: 25 }).map((_, index) => (
              <span
                key={index}
                className={cn(
                  'aspect-square',
                  [
                    0, 1, 2, 4, 5, 7, 9, 10, 12, 14, 15, 16, 18, 20, 22, 23, 24,
                  ].includes(index)
                    ? 'bg-[#1f2d25]'
                    : 'bg-white',
                )}
              />
            ))}
          </div>
          <div className="text-right">
            <p className="text-[9px] text-[#7d8881]">Total TTC</p>
            <p className="mt-1 text-base font-semibold text-[#22372a]">
              11 080.25 CHF
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectsView() {
  return (
    <div className="showcase-panel grid gap-4 lg:grid-cols-[1.08fr_.92fr]">
      <div className="rounded-2xl border border-[#dfe5e0] bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-[#a36b24]">
              Projet / chantier
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-.03em] text-[#22372a]">
              Rénovation intérieure — exemple
            </h3>
          </div>
          <span className="rounded-full bg-[#e7f1e9] px-3 py-1 text-[10px] font-semibold text-[#37694c]">
            En cours · 68 %
          </span>
        </div>
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-[#edf0ed]">
          <span className="project-progress block h-full w-[68%] rounded-full bg-gradient-to-r from-[#2b6446] to-[#78a783]" />
        </div>
        <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Durée réelle', '19 jours'],
            ['Temps pointé', '126 h'],
            ['Facturé', '28 400 CHF'],
            ['Dépenses', '16 120 CHF'],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-[9px] text-[#88938c]">{label}</p>
              <p className="mt-1.5 text-sm font-semibold text-[#304538]">
                {value}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-7 grid gap-2 sm:grid-cols-3">
          {['Préparation', 'Exécution', 'Réception'].map((step, index) => (
            <div key={step} className="rounded-xl bg-[#f3f6f3] p-3">
              <span
                className={`block size-2 rounded-full ${index < 2 ? 'bg-[#4d8a62]' : 'bg-[#d2d9d3]'}`}
              />
              <p className="mt-3 text-[10px] font-medium text-[#4b5b52]">
                {step}
              </p>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl bg-[#f0e8d9] p-5 sm:p-6">
        <Calculator className="size-5 text-[#a66b20]" />
        <p className="mt-4 text-[10px] font-semibold uppercase tracking-[.12em] text-[#8e692f]">
          Rentabilité calculée
        </p>
        <p className="mt-3 text-3xl font-semibold tracking-[-.05em] text-[#26392e]">
          43,2 %
        </p>
        <p className="mt-2 text-xs leading-5 text-[#6e685d]">
          À partir des factures, heures et dépenses réellement enregistrées.
        </p>
        <div className="mt-7 space-y-3 border-t border-[#d9cdb8] pt-5 text-[10px]">
          <div className="flex justify-between">
            <span>Revenus nets</span>
            <strong>26 368 CHF</strong>
          </div>
          <div className="flex justify-between">
            <span>Coûts enregistrés</span>
            <strong>14 978 CHF</strong>
          </div>
          <div className="flex justify-between text-[#386648]">
            <span>Marge</span>
            <strong>11 390 CHF</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

function PayrollView() {
  return (
    <div className="showcase-panel grid gap-4 lg:grid-cols-[.92fr_1.08fr]">
      <div className="rounded-2xl bg-[#173d2c] p-5 text-white sm:p-6">
        <ScanLine className="size-5 text-[#efb157]" />
        <p className="mt-5 text-[10px] font-semibold uppercase tracking-[.13em] text-[#efb157]">
          Import documentaire local
        </p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-.04em]">
          Importez plusieurs fiches sans ressaisir chaque salarié.
        </h3>
        <div className="mt-6 space-y-2.5">
          {[
            [FileText, 'PDF et images', 'Ajout groupé'],
            [Cpu, 'Texte puis SmolVLM', 'Sur ce PC'],
            [ShieldCheck, 'Comparaison humaine', 'Obligatoire'],
          ].map(([Icon, label, detail]) => (
            <div
              key={label as string}
              className="flex items-center gap-3 rounded-xl bg-white/7 px-3 py-2.5"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/8 text-[#7dd196]">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 text-[10px] text-white/76">{label as string}</span>
              <span className="text-[10px] text-white/65">{detail as string}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-[#dfe5e0] bg-white p-5 sm:p-6">
        <div className="flex items-center justify-between border-b border-[#e8ece9] pb-4">
          <div>
            <p className="text-sm font-semibold text-[#2c4034]">
              Proposition extraite
            </p>
            <p className="mt-1 text-[9px] text-[#87928b]">
              Août 2026 · exemple du site
            </p>
          </div>
          <span className="rounded-full bg-[#fff0d9] px-2.5 py-1 text-[9px] font-semibold text-[#96601f]">
            À contrôler
          </span>
        </div>
        <div className="mt-5 space-y-3 text-[10px]">
          {[
            ['Salaire brut', '6 240.00 CHF'],
            ['AVS / AI / APG', '331.75 CHF'],
            ['AC', '68.65 CHF'],
            ['LPP', '312.00 CHF'],
            ['AANP', '74.90 CHF'],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <span className="text-[#6f7b74]">{label}</span>
              <span className="font-medium text-[#34483b]">{value}</span>
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-xl bg-[#edf4ee] p-4">
          <div className="flex justify-between gap-4">
            <span className="text-xs font-semibold text-[#365143]">Net détecté</span>
            <span className="text-base font-semibold text-[#2f6547]">5 452.70 CHF</span>
          </div>
          <div className="mt-3 flex items-start gap-2 border-t border-[#d8e5da] pt-3 text-[9px] leading-4 text-[#577064]">
            <Check className="mt-0.5 size-3.5 shrink-0 text-[#3d7a54]" />
            Comparé au document original avant création
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountingView() {
  return (
    <div className="showcase-panel rounded-2xl border border-[#dfe5e0] bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[.13em] text-[#9b692a]">
            Comptabilité liée après configuration
          </p>
          <h3 className="mt-2 text-xl font-semibold tracking-[-.03em] text-[#263a2e]">
            Journal équilibré et traçable
          </h3>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e8f2e9] px-3 py-1.5 text-[10px] font-semibold text-[#34694a]">
          <ShieldCheck className="size-3.5" /> Débit = crédit
        </span>
      </div>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[10px]">
          <thead className="border-b border-[#dfe5e0] text-[#7c8880]">
            <tr>
              <th className="pb-3 font-medium">Date</th>
              <th className="pb-3 font-medium">Pièce</th>
              <th className="pb-3 font-medium">Compte</th>
              <th className="pb-3 text-right font-medium">Débit</th>
              <th className="pb-3 text-right font-medium">Crédit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#edf0ee] text-[#47574e]">
            <tr>
              <td className="py-3">31.08</td>
              <td>FA-0086</td>
              <td>1100 Débiteurs</td>
              <td className="text-right">11 080.25</td>
              <td className="text-right">—</td>
            </tr>
            <tr>
              <td className="py-3">31.08</td>
              <td>FA-0086</td>
              <td>3200 Prestations</td>
              <td className="text-right">—</td>
              <td className="text-right">10 250.00</td>
            </tr>
            <tr>
              <td className="py-3">31.08</td>
              <td>FA-0086</td>
              <td>2200 TVA due</td>
              <td className="text-right">—</td>
              <td className="text-right">830.25</td>
            </tr>
          </tbody>
          <tfoot className="border-t border-[#dfe5e0] font-semibold text-[#294032]">
            <tr>
              <td className="pt-4" colSpan={3}>
                Totaux
              </td>
              <td className="pt-4 text-right">11 080.25</td>
              <td className="pt-4 text-right">11 080.25</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-2 text-center text-[9px]">
        {['Journal', 'Grand livre', 'Bilan & résultat'].map((label) => (
          <div
            key={label}
            className="rounded-xl bg-[#f4f6f4] px-2 py-3 font-medium text-[#506158]"
          >
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

const panels = [
  DashboardView,
  DocumentsView,
  ProjectsView,
  PayrollView,
  AccountingView,
];

export function ProductShowcase() {
  const [active, setActive] = useState(0);
  const [automatic, setAutomatic] = useState(true);
  const baseId = 'elyko-product-tour';

  useEffect(() => {
    if (
      !automatic ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const timer = window.setInterval(
      () => setActive((value) => (value + 1) % views.length),
      6200,
    );
    return () => window.clearInterval(timer);
  }, [automatic]);

  const Panel = panels[active];

  return (
    <div>
      <div
        className="horizontal-rail -mx-5 flex snap-x gap-2 overflow-x-auto px-5 pb-3 sm:mx-0 sm:grid sm:grid-cols-5 sm:overflow-visible sm:px-0"
        role="tablist"
        aria-label="Visite guidée d’Elyko"
      >
        {views.map(({ label, icon: Icon }, index) => (
          <button
            key={label}
            id={`${baseId}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={active === index}
            aria-controls={`${baseId}-panel`}
            tabIndex={active === index ? 0 : -1}
            onClick={() => {
              setActive(index);
              setAutomatic(false);
            }}
            onKeyDown={(event) => {
              const direction =
                event.key === 'ArrowRight'
                  ? 1
                  : event.key === 'ArrowLeft'
                    ? -1
                    : 0;
              const requested =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? views.length - 1
                    : direction
                      ? (index + direction + views.length) % views.length
                      : null;
              if (requested === null) return;
              event.preventDefault();
              setActive(requested);
              setAutomatic(false);
              document.getElementById(`${baseId}-tab-${requested}`)?.focus();
            }}
            className={cn(
              'relative flex min-h-12 min-w-[154px] snap-start items-center justify-center gap-2 overflow-hidden rounded-xl border px-3 text-xs font-semibold transition-colors sm:min-w-0',
              active === index
                ? 'border-[#315f47] bg-[#173d2c] text-white'
                : 'border-[#d8ded9] bg-white text-[#5c6b63] hover:border-[#aebbb2] hover:text-[#294b39]',
            )}
          >
            <Icon className="size-4" /> {label}
            {active === index && automatic && (
              <span className="showcase-tab-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-[#efaa3c]" />
            )}
          </button>
        ))}
      </div>

      <div className="mt-3 overflow-hidden rounded-[26px] border border-[#cfd8d1] bg-[#eef2ef] shadow-[0_30px_80px_rgba(23,61,44,.14)]">
        <div className="flex h-11 items-center justify-between border-b border-[#d8dfda] bg-white px-4">
          <div className="flex items-center gap-2 text-[10px] font-semibold text-[#42534a]">
            <BrandMark className="size-5" /> Elyko
          </div>
          <div className="flex h-full items-center text-[12px] text-[#69766f]">
            <span className="grid h-full w-8 place-items-center">—</span>
            <span className="grid h-full w-8 place-items-center">□</span>
            <span className="grid h-full w-8 place-items-center">×</span>
          </div>
        </div>
        <div className="grid min-h-[440px] sm:grid-cols-[158px_1fr] lg:min-h-[510px]">
          <aside className="hidden bg-[#173d2c] p-4 text-white sm:flex sm:flex-col">
            <p className="text-[9px] font-semibold uppercase tracking-[.14em] text-white/35">
              Navigation
            </p>
            <div className="mt-4 space-y-1.5">
              {views.map(({ label, icon: Icon }, index) => (
                <div
                  key={label}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-2.5 py-2 text-[10px]',
                    active === index
                      ? 'bg-white/12 text-white'
                      : 'text-white/42',
                  )}
                >
                  <Icon className="size-3.5" /> {label}
                </div>
              ))}
            </div>
            <div className="mt-auto rounded-xl border border-white/10 p-3 text-[9px] text-white/55">
              <span className="flex items-center gap-2 font-semibold text-white/80">
                <span className="local-pulse size-1.5 rounded-full bg-[#63d18a]" />{' '}
                Stockage local
              </span>
              <span className="mt-1.5 block leading-4">
                Aucun envoi de données métier
              </span>
            </div>
          </aside>
          <div
            id={`${baseId}-panel`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${active}`}
            key={active}
            className="min-w-0 p-3 sm:p-5 lg:p-6"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-[.13em] text-[#8f6a37]">
                  Aperçu interactif
                </p>
                <h3 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#24382b]">
                  {views[active].label}
                </h3>
              </div>
              <span className="rounded-full border border-[#d3ddd5] bg-white px-2.5 py-1 text-[9px] font-medium text-[#65736b]">
                Exemples fictifs du site
              </span>
            </div>
            <Panel />
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-xs leading-5 text-[#727e76]">
        Cliquez sur les onglets pour découvrir le fonctionnement. Les exemples
        affichés ici ne sont jamais ajoutés dans l’application installée.
      </p>
    </div>
  );
}
