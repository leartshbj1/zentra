'use client';

import {
  Building2,
  Check,
  FileCheck2,
  Package,
  Percent,
  RefreshCcw,
  Receipt,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatChfCents, formatPercentFromBasisPoints } from '@/lib/site-format';

const catalogItems = [
  {
    id: 'service-conseil',
    kind: 'Service',
    name: 'Conseil sur site',
    unit: 'heure',
    salesPriceCents: 14500,
    vatBp: 810,
  },
  {
    id: 'kit-installation',
    kind: 'Produit',
    name: 'Kit d’installation',
    unit: 'pièce',
    salesPriceCents: 89000,
    vatBp: 810,
  },
  {
    id: 'forfait-deplacement',
    kind: 'Service',
    name: 'Forfait déplacement',
    unit: 'forfait',
    salesPriceCents: 9500,
    vatBp: 810,
  },
] as const;

type DemoMode = 'quote' | 'purchase';
type PurchaseStatus = 'ordered' | 'received' | 'matched' | 'paid';

export function BusinessOperationsDemo() {
  // Cette démonstration n'est montée qu'une fois sur la page d'accueil. Des
  // identifiants fixes gardent les relations ARIA stables entre le rendu RSC
  // et l'hydratation du navigateur.
  const baseId = 'zentra-business-operations';
  const [mode, setMode] = useState<DemoMode>('quote');
  const [catalogItemId, setCatalogItemId] = useState(catalogItems[0].id);
  const [quantity, setQuantity] = useState(2);
  const [discount, setDiscount] = useState(10);
  const [purchaseStatus, setPurchaseStatus] =
    useState<PurchaseStatus>('ordered');
  const [confirmPayment, setConfirmPayment] = useState(false);
  const [paidAt, setPaidAt] = useState<string | null>(null);

  const selectedItem =
    catalogItems.find((item) => item.id === catalogItemId) ?? catalogItems[0];
  const totals = useMemo(() => {
    const grossCents = selectedItem.salesPriceCents * quantity;
    const netCents = Math.round(grossCents * (1 - discount / 100));
    const vatCents = Math.round((netCents * selectedItem.vatBp) / 10000);

    return { grossCents, netCents, vatCents, totalCents: netCents + vatCents };
  }, [discount, quantity, selectedItem]);

  const resetPurchase = () => {
    setPurchaseStatus('ordered');
    setConfirmPayment(false);
    setPaidAt(null);
  };

  const markPurchasePaid = () => {
    setPurchaseStatus('paid');
    setConfirmPayment(false);
    setPaidAt(
      new Intl.DateTimeFormat('fr-CH', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date()),
    );
  };

  const purchaseSteps: Array<{
    id: PurchaseStatus;
    label: string;
    detail: string;
  }> = [
    {
      id: 'ordered',
      label: 'Commande',
      detail: 'BC-2026-018 confirmée',
    },
    {
      id: 'received',
      label: 'Réception',
      detail: 'BR-2026-009 émise',
    },
    {
      id: 'matched',
      label: 'Facture',
      detail: '3 pièces concordantes',
    },
    {
      id: 'paid',
      label: 'Paiement',
      detail: paidAt ? `Confirmé le ${paidAt}` : 'À confirmer',
    },
  ];
  const purchaseStepIndex = purchaseSteps.findIndex(
    (step) => step.id === purchaseStatus,
  );

  return (
    <div className="overflow-hidden rounded-[28px] border border-[#d8ddd8] bg-[#f1f5f2] shadow-[0_24px_70px_rgba(29,54,39,.1)]">
      <div className="flex flex-col gap-4 border-b border-[#d9e0da] bg-white/80 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.12em] text-[#8c5d20]">
            Démonstration locale du site
          </p>
          <p className="mt-1 text-sm text-[#657169]">
            Essayez le flux sans compte, sans sauvegarde et sans envoi réseau.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#cddbd0] bg-[#eef7f0] px-3 py-1.5 text-[11px] font-semibold text-[#315e47]">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Exemples fictifs
        </span>
      </div>

      <div
        className="grid grid-cols-2 gap-1 border-b border-[#d9e0da] bg-[#e6ece7] p-1.5"
        role="tablist"
        aria-label="Choisir une démonstration Zentra"
      >
        <button
          id={baseId + '-quote-tab'}
          type="button"
          role="tab"
          aria-selected={mode === 'quote'}
          aria-controls={baseId + '-quote-panel'}
          onClick={() => setMode('quote')}
          className={`flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315e47] ${
            mode === 'quote'
              ? 'bg-white text-[#21402f] shadow-sm'
              : 'text-[#5f6c64] hover:bg-white/55'
          }`}
        >
          <FileCheck2 className="size-4" aria-hidden="true" />
          Catalogue → devis
        </button>
        <button
          id={baseId + '-purchase-tab'}
          type="button"
          role="tab"
          aria-selected={mode === 'purchase'}
          aria-controls={baseId + '-purchase-panel'}
          onClick={() => setMode('purchase')}
          className={`flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315e47] ${
            mode === 'purchase'
              ? 'bg-white text-[#21402f] shadow-sm'
              : 'text-[#5f6c64] hover:bg-white/55'
          }`}
        >
          <Receipt className="size-4" aria-hidden="true" />
          Fournisseur → achat
        </button>
      </div>

      <div
        id={baseId + '-quote-panel'}
        role="tabpanel"
        aria-labelledby={baseId + '-quote-tab'}
        hidden={mode !== 'quote'}
        className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[.86fr_1.14fr] lg:p-7"
      >
        <div className="rounded-2xl border border-[#dce3dd] bg-white p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[#e8f1ea] text-[#356249]">
              <Package className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-semibold text-[#273c30]">
                Ajouter du catalogue
              </p>
              <p className="text-xs text-[#6a766e]">
                Références actives uniquement
              </p>
            </div>
          </div>

          <label
            className="mt-6 block text-xs font-semibold text-[#435249]"
            htmlFor={baseId + '-catalog-item'}
          >
            Produit ou service
          </label>
          <select
            id={baseId + '-catalog-item'}
            value={catalogItemId}
            onChange={(event) =>
              setCatalogItemId(event.target.value as typeof catalogItemId)
            }
            className="mt-2 min-h-12 w-full rounded-xl border border-[#cfd8d1] bg-white px-3 text-sm text-[#263b2e] outline-none transition focus:border-[#4b795e] focus:ring-2 focus:ring-[#4b795e]/15"
          >
            {catalogItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.kind} · {item.name}
              </option>
            ))}
          </select>

          <div className="mt-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            <label className="text-xs font-semibold text-[#435249]">
              Quantité
              <input
                type="number"
                min={1}
                max={99}
                inputMode="numeric"
                value={quantity}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setQuantity(
                    Number.isFinite(next) ? Math.min(99, Math.max(1, next)) : 1,
                  );
                }}
                className="mt-2 min-h-12 w-full rounded-xl border border-[#cfd8d1] bg-white px-3 text-sm outline-none transition focus:border-[#4b795e] focus:ring-2 focus:ring-[#4b795e]/15"
              />
            </label>
            <label className="text-xs font-semibold text-[#435249]">
              Remise
              <span className="relative mt-2 flex min-h-12 items-center rounded-xl border border-[#cfd8d1] bg-white px-3">
                <input
                  type="number"
                  min={0}
                  max={100}
                  inputMode="numeric"
                  value={discount}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setDiscount(
                      Number.isFinite(next)
                        ? Math.min(100, Math.max(0, next))
                        : 0,
                    );
                  }}
                  aria-label="Remise en pour-cent"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
                <Percent className="size-4 text-[#78837c]" aria-hidden="true" />
              </span>
            </label>
          </div>

          <p className="mt-5 rounded-xl bg-[#f4f1e9] p-3 text-xs leading-5 text-[#6c624f]">
            Zentra copie le libellé, l’unité, le prix et la TVA dans la ligne du
            devis. La ligne reste modifiable sans changer la référence du
            catalogue.
          </p>
        </div>

        <div className="rounded-2xl bg-[#173d2c] p-5 text-white sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/12 pb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.11em] text-[#efb157]">
                Ligne de devis
              </p>
              <h3 className="mt-2 text-xl font-semibold tracking-[-.03em]">
                {selectedItem.name}
              </h3>
            </div>
            <span className="rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/80">
              {selectedItem.kind}
            </span>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['Quantité', String(quantity)],
              ['Unité', selectedItem.unit],
              [
                'Prix unitaire',
                formatChfCents(selectedItem.salesPriceCents),
              ],
              [
                'TVA',
                formatPercentFromBasisPoints(selectedItem.vatBp),
              ],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-white/[.075] p-3">
                <dt className="text-[11px] text-white/60">{label}</dt>
                <dd className="mt-1 font-semibold text-white/90">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 space-y-2.5 border-t border-white/12 pt-5 text-sm">
            <div className="flex justify-between gap-4 text-white/70">
              <span>Avant remise</span>
              <span>{formatChfCents(totals.grossCents)}</span>
            </div>
            <div className="flex justify-between gap-4 text-[#efc27f]">
              <span>Remise {discount} %</span>
              <span>
                − {formatChfCents(totals.grossCents - totals.netCents)}
              </span>
            </div>
            <div className="flex justify-between gap-4 text-white/70">
              <span>TVA</span>
              <span>{formatChfCents(totals.vatCents)}</span>
            </div>
            <div className="flex items-end justify-between gap-4 border-t border-white/12 pt-4">
              <span className="font-semibold">Total TTC</span>
              <strong className="text-2xl tracking-[-.04em] text-[#efb157]">
                {formatChfCents(totals.totalCents)}
              </strong>
            </div>
          </div>
        </div>
      </div>

      <div
        id={baseId + '-purchase-panel'}
        role="tabpanel"
        aria-labelledby={baseId + '-purchase-tab'}
        hidden={mode !== 'purchase'}
        className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[.78fr_1.22fr] lg:p-7"
      >
        <div className="grid grid-cols-1 gap-2 min-[430px]:grid-cols-2 lg:grid-cols-1">
          {purchaseSteps.map((step, index) => {
            const completed = index <= purchaseStepIndex;
            return (
              <div
                key={step.id}
                className={`flex items-center gap-3 rounded-2xl border p-3 sm:p-4 ${
                  completed
                    ? 'border-[#c8d9cd] bg-white'
                    : 'border-[#dce3dd] bg-white/55'
                }`}
              >
                <span
                  className={`grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold ${
                    completed
                      ? 'bg-[#2f6848] text-white'
                      : 'bg-[#e5e9e6] text-[#718078]'
                  }`}
                  aria-hidden="true"
                >
                  {completed ? <Check className="size-4" /> : index + 1}
                </span>
                <span className="min-w-0">
                  <strong className="block text-sm text-[#294033]">
                    {step.label}
                  </strong>
                  <small className="mt-0.5 block text-xs leading-5 text-[#68746c]">
                    {completed ? step.detail : 'Étape suivante'}
                  </small>
                </span>
              </div>
            );
          })}
        </div>

        <div className="rounded-2xl border border-[#dce3dd] bg-white p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#e8f1ea] text-[#356249]">
                <Building2 className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold text-[#273c30]">
                  Atelier Romand SA
                </p>
                <p className="mt-0.5 text-xs text-[#6a766e]">
                  Commande fournisseur BC-2026-018
                </p>
              </div>
            </div>
            <span
              className={`rounded-full px-3 py-1.5 text-[11px] font-semibold ${
                purchaseStatus === 'paid'
                  ? 'bg-[#e7f2e9] text-[#34684a]'
                  : purchaseStatus === 'matched'
                    ? 'bg-[#fff0d9] text-[#805019]'
                    : 'bg-[#fff0d9] text-[#805019]'
              }`}
            >
              {purchaseStatus === 'paid'
                ? 'Payé'
                : purchaseStatus === 'matched'
                  ? 'À payer'
                  : purchaseStatus === 'received'
                    ? 'À rapprocher'
                    : 'À réceptionner'}
            </span>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-4 border-y border-[#e7ebe8] py-5 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-[#748078]">Commande</dt>
              <dd className="mt-1 font-semibold text-[#2d4336]">
                2 480.60 CHF
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[#748078]">Réception</dt>
              <dd className="mt-1 font-semibold text-[#2d4336]">
                {purchaseStepIndex >= 1 ? 'BR-2026-009' : 'À émettre'}
              </dd>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <dt className="text-xs text-[#748078]">Facture</dt>
              <dd className="mt-1 font-semibold text-[#2d4336]">
                {purchaseStepIndex >= 2 ? 'AF-2026-014' : 'En attente'}
              </dd>
            </div>
          </dl>

          <div className="mt-5" aria-live="polite">
            {purchaseStatus === 'paid' ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-start gap-2 text-sm leading-6 text-[#356249]">
                  <Check className="mt-1 size-4 shrink-0" aria-hidden="true" />
                  Paiement confirmé dans cette démonstration.
                </p>
                <button
                  type="button"
                  onClick={resetPurchase}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#cfd8d1] px-4 text-sm font-semibold text-[#415248] transition hover:bg-[#f3f6f3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315e47]"
                >
                  <RefreshCcw className="size-4" aria-hidden="true" />
                  Recommencer
                </button>
              </div>
            ) : purchaseStatus === 'matched' && confirmPayment ? (
              <div className="rounded-xl border border-[#e7c88e] bg-[#fff8ea] p-4">
                <p className="text-sm font-semibold text-[#684b22]">
                  Confirmer le paiement avec la date du jour ?
                </p>
                <p className="mt-1 text-xs leading-5 text-[#776443]">
                  Dans Zentra, une écriture devient immuable si la comptabilité
                  est activée. Ici, rien n’est enregistré.
                </p>
                <div className="mt-4 flex flex-col gap-2 min-[420px]:flex-row">
                  <button
                    type="button"
                    onClick={markPurchasePaid}
                    className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#173d2c] px-4 text-sm font-semibold text-white transition hover:bg-[#24563f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315e47]"
                  >
                    Confirmer le paiement
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmPayment(false)}
                    className="inline-flex min-h-11 items-center justify-center rounded-full border border-[#d8cfbe] px-4 text-sm font-semibold text-[#5d5548] transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315e47]"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            ) : purchaseStatus === 'ordered' ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-[#6c776f]">
                  L’émission du bon enregistre la réception. Le stock ne bouge
                  pas au simple brouillon.
                </p>
                <button
                  type="button"
                  onClick={() => setPurchaseStatus('received')}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-[#e9a33a] px-5 text-sm font-semibold text-[#173d2c] transition hover:bg-[#f0b252] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#805019]"
                >
                  Émettre la réception
                </button>
              </div>
            ) : purchaseStatus === 'received' ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-[#6c776f]">
                  Zentra compare quantité, prix HT et TVA avec la commande et la
                  réception avant validation.
                </p>
                <button
                  type="button"
                  onClick={() => setPurchaseStatus('matched')}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-[#e9a33a] px-5 text-sm font-semibold text-[#173d2c] transition hover:bg-[#f0b252] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#805019]"
                >
                  Rapprocher la facture
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-[#6c776f]">
                  Les trois pièces concordent. Le paiement reste une action
                  distincte et explicite.
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmPayment(true)}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-[#e9a33a] px-5 text-sm font-semibold text-[#173d2c] transition hover:bg-[#f0b252] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#805019]"
                >
                  Marquer payé aujourd’hui
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
