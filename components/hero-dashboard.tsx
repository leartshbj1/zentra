import {
  BarChart3,
  Clock3,
  FileCheck2,
  FolderKanban,
  LayoutDashboard,
  Receipt,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';

const navItems = [
  [LayoutDashboard, 'Vue d’ensemble'],
  [FolderKanban, 'Projets'],
  [FileCheck2, 'Devis'],
  [Receipt, 'Factures'],
  [Clock3, 'Temps'],
  [Users, 'Équipe'],
] as const;

export function HeroDashboard() {
  return (
    <div className="relative" aria-hidden="true">
      <div className="hero-orbit hero-orbit-one" />
      <div className="hero-orbit hero-orbit-two" />
      <div className="hero-product-window relative overflow-hidden rounded-[26px] border border-[#ced5ce] bg-[#f8faf8] shadow-[0_38px_100px_rgba(16,43,30,.22)]">
        <div className="flex h-11 items-center justify-between border-b border-[#dfe4df] bg-white/90 px-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-[#34473c]">
            <BrandMark className="size-5 rounded-md" />
            Elyko
          </div>
          <div className="flex h-full items-center text-[13px] text-[#5f6c65]">
            <span className="grid h-full w-9 place-items-center">—</span>
            <span className="grid h-full w-9 place-items-center">□</span>
            <span className="grid h-full w-9 place-items-center">×</span>
          </div>
        </div>

        <div className="grid min-h-[430px] grid-cols-1 sm:grid-cols-[148px_1fr] lg:min-h-[500px]">
          <aside className="hidden bg-[#153b2a] p-3 text-white sm:flex sm:flex-col">
            <p className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-[.11em] text-white/70">
              Espace de travail
            </p>
            <div className="mt-4 space-y-1">
              {navItems.map(([Icon, label], index) => (
                <div
                  key={label}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] ${
                    index === 0 ? 'bg-white/12 text-white' : 'text-white/72'
                  }`}
                >
                  <Icon className="size-3.5" />
                  {label}
                </div>
              ))}
            </div>
            <div className="mt-auto rounded-xl border border-white/10 bg-white/6 p-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-white/85">
                <span className="local-pulse size-1.5 rounded-full bg-[#5ed38a]" />
                Base locale active
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-white/68">
                Données enregistrées sur ce PC
              </p>
            </div>
          </aside>

          <div className="min-w-0 p-4 sm:p-5 lg:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium text-[#647169]">
                  LUNDI 31 AOÛT
                </p>
                <h2 className="mt-1 text-lg font-semibold tracking-[-.03em] text-[#1d2d24] sm:text-xl">
                  Bonjour, votre activité en un coup d’œil.
                </h2>
              </div>
              <span className="hidden max-w-full flex-wrap items-center gap-1.5 rounded-full bg-[#e7f1e9] px-2.5 py-1 text-[11px] font-semibold leading-4 text-[#2f6647] min-[430px]:inline-flex">
                <ShieldCheck className="size-3" /> Local
              </span>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-3">
              {[
                ['À facturer', '18 450 CHF', '+ 3 dossiers'],
                ['En attente', '7 280 CHF', '2 échéances'],
                ['Heures ce mois', '164 h', 'Équipe complète'],
              ].map(([label, value, detail], index) => (
                <div
                  key={label}
                  className={`hero-stat rounded-xl border border-[#dde4de] bg-white p-3 ${
                    index === 2
                      ? 'hidden min-[430px]:col-span-2 min-[430px]:block lg:col-span-1'
                      : ''
                  }`}
                  style={{ animationDelay: `${220 + index * 90}ms` }}
                >
                  <p className="text-[11px] font-medium text-[#647169]">
                    {label}
                  </p>
                  <p className="mt-2 text-base font-semibold tracking-[-.03em] text-[#23372b] sm:text-lg">
                    {value}
                  </p>
                  <p className="mt-1 text-[11px] leading-4 text-[#845718]">{detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-2.5 grid gap-2.5 lg:grid-cols-[1.08fr_.92fr]">
              <div className="hidden rounded-xl border border-[#dde4de] bg-white p-3.5 lg:block">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[11px] font-semibold text-[#2d4135]">
                      Activité facturée
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#65716a]">
                      6 derniers mois · exemple
                    </p>
                  </div>
                  <BarChart3 className="size-4 text-[#b67522]" />
                </div>
                <div className="mt-5 flex h-24 items-end gap-2 sm:h-28">
                  {[38, 58, 46, 72, 61, 88].map((height, index) => (
                    <div key={index} className="flex h-full flex-1 items-end">
                      <span
                        className="hero-chart-bar block w-full rounded-t-md bg-gradient-to-t from-[#275c42] to-[#73a17e]"
                        style={{
                          height: `${height}%`,
                          animationDelay: `${380 + index * 80}ms`,
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-6 text-center text-[10px] text-[#68736c]">
                  {['M', 'A', 'M', 'J', 'J', 'A'].map((month, index) => (
                    <span key={`${month}-${index}`}>{month}</span>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-[#dde4de] bg-white p-3.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-semibold text-[#2d4135]">
                    Dossiers actifs
                  </p>
                  <span className="text-[11px] text-[#5f6b64]">Voir tout</span>
                </div>
                <div className="mt-3 space-y-3">
                  {[
                    ['Rénovation intérieure', '68%', '#d9902f'],
                    ['Mandat conseil', '42%', '#4a7a5d'],
                    ['Installation technique', '86%', '#6d9377'],
                  ].map(([label, progress, color]) => (
                    <div key={label}>
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate font-medium text-[#43534a]">
                          {label}
                        </span>
                        <span className="text-[#89948d]">{progress}</span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#edf0ed]">
                        <span
                          className="hero-progress-bar block h-full rounded-full"
                          style={{ width: progress, backgroundColor: color }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#eadfcf] bg-[#fff9ee] px-3.5 py-3 text-[11px] leading-4 text-[#624e32]">
              <span className="font-medium">Devis accepté · DV-2026-0042</span>
              <span className="rounded-full bg-[#dceade] px-2 py-1 font-semibold text-[#316347]">
                Convertir en facture
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="hero-proof-chip absolute -bottom-4 left-3 flex max-w-[calc(100%_-_1.5rem)] flex-wrap items-center gap-2 rounded-full border border-[#d4dcd5] bg-white px-3 py-2 text-[11px] font-semibold leading-4 text-[#365044] shadow-lg sm:left-auto sm:right-6">
        <ShieldCheck className="size-3.5 text-[#3c7452]" />
        Interface Elyko · données d’exemple
      </div>
    </div>
  );
}
