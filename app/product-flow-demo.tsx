'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  PackageCheck,
  Receipt,
  RotateCcw,
  Truck,
} from 'lucide-react';

const demoStages = ['draft', 'accepted', 'order', 'delivery', 'invoice'] as const;
type DemoStage = (typeof demoStages)[number];

function numberValue(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(cents: number) {
  return new Intl.NumberFormat('fr-CH', {
    style: 'currency',
    currency: 'CHF',
  }).format(cents / 100);
}

export function ProductFlowDemo() {
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [discount, setDiscount] = useState('');
  const [vatRate, setVatRate] = useState('');
  const [deliveredQuantity, setDeliveredQuantity] = useState('');
  const [stage, setStage] = useState<DemoStage>('draft');

  const totals = useMemo(() => {
    const quantityValue = Math.max(0, numberValue(quantity));
    const unitPriceCents = Math.max(0, Math.round(numberValue(unitPrice) * 100));
    const discountBp = Math.min(
      10_000,
      Math.max(0, Math.round(numberValue(discount) * 100)),
    );
    const vatBp = Math.max(0, Math.round(numberValue(vatRate) * 100));
    const beforeDiscountCents = Math.round(quantityValue * unitPriceCents);
    const discountCents = Math.round(
      (beforeDiscountCents * discountBp) / 10_000,
    );
    const netCents = beforeDiscountCents - discountCents;
    const vatCents = Math.round((netCents * vatBp) / 10_000);
    return {
      beforeDiscountCents,
      discountCents,
      netCents,
      vatCents,
      totalCents: netCents + vatCents,
    };
  }, [discount, quantity, unitPrice, vatRate]);

  const deliveredTotals = useMemo(() => {
    const orderedQuantity = Math.max(0, numberValue(quantity));
    const delivered = Math.min(
      orderedQuantity,
      Math.max(0, numberValue(deliveredQuantity)),
    );
    const unitPriceCents = Math.max(0, Math.round(numberValue(unitPrice) * 100));
    const discountBp = Math.min(
      10_000,
      Math.max(0, Math.round(numberValue(discount) * 100)),
    );
    const vatBp = Math.max(0, Math.round(numberValue(vatRate) * 100));
    const beforeDiscountCents = Math.round(delivered * unitPriceCents);
    const discountCents = Math.round(
      (beforeDiscountCents * discountBp) / 10_000,
    );
    const netCents = beforeDiscountCents - discountCents;
    const vatCents = Math.round((netCents * vatBp) / 10_000);
    return {
      beforeDiscountCents,
      discountCents,
      netCents,
      vatCents,
      totalCents: netCents + vatCents,
    };
  }, [deliveredQuantity, discount, quantity, unitPrice, vatRate]);

  const complete =
    description.trim().length > 0 &&
    numberValue(quantity) > 0 &&
    unitPrice.trim() !== '' &&
    numberValue(unitPrice) >= 0 &&
    vatRate !== '';
  const orderedQuantity = Math.max(0, numberValue(quantity));
  const deliveredQuantityValue = Math.max(0, numberValue(deliveredQuantity));
  const deliveryReady =
    deliveredQuantityValue > 0 && deliveredQuantityValue <= orderedQuantity;
  const fullDelivery =
    deliveryReady && Math.abs(deliveredQuantityValue - orderedQuantity) < 0.000_001;
  const deliveredStage = stage === 'delivery' || stage === 'invoice';
  const displayedTotals = deliveredStage ? deliveredTotals : totals;
  const locked = stage === 'order' || deliveredStage;

  function edit(setter: (value: string) => void, value: string) {
    setter(value);
    setDeliveredQuantity('');
    setStage('draft');
  }

  function reset() {
    setDescription('');
    setQuantity('');
    setUnitPrice('');
    setDiscount('');
    setVatRate('');
    setDeliveredQuantity('');
    setStage('draft');
  }

  return (
    <div className="flow-demo overflow-hidden rounded-[28px] border border-[#d8d4ca] bg-white shadow-[0_24px_70px_rgba(29,54,40,.09)]">
      <div className="grid lg:grid-cols-[.7fr_1.3fr]">
        <aside className="bg-[#173d2c] p-6 text-white sm:p-8">
          <p className="text-[11px] font-semibold uppercase tracking-[.13em] text-[#efb157]">
            Démonstration locale du site
          </p>
          <h3 className="mt-4 text-2xl font-semibold tracking-[-.04em]">
            Du devis accepté à la facture, étape par étape.
          </h3>
          <p className="mt-4 text-sm leading-6 text-white/72">
            Saisissez une ligne à livrer pour essayer le flux commande. Cet
            exemple ne contient aucune donnée d’entreprise préchargée.
          </p>
          <ol className="mt-8 grid gap-3" aria-label="Étapes de la démonstration">
            {[
              ['draft', '1', 'Préparer le devis'],
              ['accepted', '2', 'Confirmer l’acceptation'],
              ['order', '3', 'Créer la commande'],
              ['delivery', '4', 'Émettre le BL'],
              ['invoice', '5', 'Facturer le livré'],
            ].map(([id, number, label]) => {
              const stepIndex = demoStages.indexOf(id as DemoStage);
              const currentIndex = demoStages.indexOf(stage);
              const reached = currentIndex >= stepIndex;
              const completed = currentIndex > stepIndex;
              return (
                <li
                  key={id}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-sm ${
                    reached
                      ? 'border-[#efb157]/35 bg-white/10 text-white'
                      : 'border-white/8 text-white/45'
                  }`}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#efb157] text-xs font-bold text-[#173d2c]">
                    {completed ? (
                      <CheckCircle2 className="size-4" />
                    ) : (
                      number
                    )}
                  </span>
                  {label}
                </li>
              );
            })}
          </ol>
          <p className="mt-8 rounded-xl border border-white/10 bg-black/10 p-3 text-xs leading-5 text-white/62">
            Rien n’est enregistré ni transmis. La démonstration s’efface au
            rechargement de la page.
          </p>
        </aside>

        <div className="p-5 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e3e1da] pb-5">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-[#e8f0ea] text-[#315f47]">
                {stage === 'invoice' ? (
                  <Receipt className="size-5" />
                ) : stage === 'delivery' ? (
                  <Truck className="size-5" />
                ) : stage === 'order' ? (
                  <PackageCheck className="size-5" />
                ) : (
                  <FileCheck2 className="size-5" />
                )}
              </span>
              <div>
                <p className="font-semibold text-[#253b2f]">
                  {stage === 'invoice'
                    ? fullDelivery
                      ? 'Facture finale brouillon créée'
                      : 'Facture de situation brouillon créée'
                    : stage === 'delivery'
                      ? 'Bon de livraison émis'
                      : stage === 'order'
                        ? 'Commande confirmée'
                    : stage === 'accepted'
                      ? 'Devis accepté'
                      : 'Nouveau devis'}
                </p>
                <p className="mt-0.5 text-xs text-[#78827c]">
                  Aucun numéro officiel n’est attribué dans cette démo.
                </p>
              </div>
            </div>
            <span
              className={`rounded-full px-3 py-1.5 text-[11px] font-bold ${
                stage === 'invoice' || stage === 'delivery'
                  ? 'bg-[#e6f1e8] text-[#2f6847]'
                  : stage === 'accepted' || stage === 'order'
                    ? 'bg-[#fff0d8] text-[#865819]'
                    : 'bg-[#eef0ed] text-[#58645d]'
              }`}
              aria-live="polite"
            >
              {stage === 'invoice'
                ? fullDelivery
                  ? 'FACTURE FINALE'
                  : 'FACTURE DE SITUATION'
                : stage === 'delivery'
                  ? 'BL ÉMIS'
                  : stage === 'order'
                    ? 'COMMANDE CONFIRMÉE'
                : stage === 'accepted'
                  ? 'DEVIS ACCEPTÉ'
                  : 'DEVIS BROUILLON'}
            </span>
          </div>

          <fieldset disabled={locked} className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-xs font-semibold text-[#526159] sm:col-span-2">
              Article ou prestation à livrer
              <input
                value={description}
                onChange={(event) => edit(setDescription, event.target.value)}
                placeholder="Saisissez votre propre description"
                className="min-h-11 rounded-xl border border-[#d7d8d2] bg-white px-3 text-sm font-normal text-[#1f3328] outline-none transition focus:border-[#59806a] focus:ring-3 focus:ring-[#59806a]/15 disabled:bg-[#f3f4f1]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#526159]">
              Quantité
              <input
                value={quantity}
                onChange={(event) => edit(setQuantity, event.target.value)}
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0"
                className="min-h-11 rounded-xl border border-[#d7d8d2] bg-white px-3 text-sm font-normal text-[#1f3328] outline-none transition focus:border-[#59806a] focus:ring-3 focus:ring-[#59806a]/15 disabled:bg-[#f3f4f1]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#526159]">
              Prix unitaire (CHF)
              <input
                value={unitPrice}
                onChange={(event) => edit(setUnitPrice, event.target.value)}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                className="min-h-11 rounded-xl border border-[#d7d8d2] bg-white px-3 text-sm font-normal text-[#1f3328] outline-none transition focus:border-[#59806a] focus:ring-3 focus:ring-[#59806a]/15 disabled:bg-[#f3f4f1]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#526159]">
              Remise (%)
              <input
                value={discount}
                onChange={(event) => edit(setDiscount, event.target.value)}
                type="number"
                min="0"
                max="100"
                step="0.01"
                placeholder="0"
                className="min-h-11 rounded-xl border border-[#d7d8d2] bg-white px-3 text-sm font-normal text-[#1f3328] outline-none transition focus:border-[#59806a] focus:ring-3 focus:ring-[#59806a]/15 disabled:bg-[#f3f4f1]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#526159]">
              TVA
              <select
                value={vatRate}
                onChange={(event) => edit(setVatRate, event.target.value)}
                className="min-h-11 rounded-xl border border-[#d7d8d2] bg-white px-3 text-sm font-normal text-[#1f3328] outline-none transition focus:border-[#59806a] focus:ring-3 focus:ring-[#59806a]/15 disabled:bg-[#f3f4f1]"
              >
                <option value="">Choisir</option>
                <option value="0">0 % — traitement à vérifier</option>
                <option value="2.6">2,6 %</option>
                <option value="3.8">3,8 %</option>
                <option value="8.1">8,1 %</option>
              </select>
            </label>
          </fieldset>

          {stage === 'order' ? (
            <div className="mt-6 grid gap-3 rounded-2xl border border-[#d8dfd9] bg-[#edf4ee] p-5 sm:grid-cols-[1fr_1.25fr] sm:items-end">
              <label className="grid gap-2 text-xs font-semibold text-[#42604f]">
                Quantité livrée sur {quantity}
                <input
                  value={deliveredQuantity}
                  onChange={(event) => setDeliveredQuantity(event.target.value)}
                  type="number"
                  min="0.01"
                  max={quantity}
                  step="0.01"
                  className="min-h-11 rounded-xl border border-[#bdcec1] bg-white px-3 text-sm font-normal text-[#1f3328] outline-none transition focus:border-[#59806a] focus:ring-3 focus:ring-[#59806a]/15"
                />
              </label>
              <p className="text-xs leading-5 text-[#52695b]">
                Elyko réserve la commande, puis limite la facture aux quantités
                réellement livrées et encore non facturées.
              </p>
            </div>
          ) : null}

          {stage === 'delivery' ? (
            <p className="mt-6 rounded-2xl border border-[#cfe0d2] bg-[#edf5ee] p-4 text-sm font-semibold text-[#35634a]" aria-live="polite">
              BL émis pour {deliveredQuantity} sur {quantity}. La sortie de stock
              est enregistrée une seule fois.
            </p>
          ) : null}

          <div className="mt-6 grid gap-5 rounded-2xl bg-[#f3f4f0] p-5 sm:grid-cols-[1fr_auto] sm:items-end">
            <dl className="grid gap-2 text-sm text-[#637068]">
              <div className="flex justify-between gap-4">
                <dt>Sous-total</dt>
                <dd>{money(displayedTotals.beforeDiscountCents)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Remise</dt>
                <dd>− {money(displayedTotals.discountCents)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>TVA</dt>
                <dd>{money(displayedTotals.vatCents)}</dd>
              </div>
            </dl>
            <div className="border-t border-[#d9dcd7] pt-4 text-right sm:min-w-44 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
              <span className="block text-xs text-[#6d7871]">
                {deliveredStage ? 'Total livré à facturer' : 'Total TTC'}
              </span>
              <strong className="mt-1 block text-2xl tracking-[-.04em] text-[#244231]">
                {money(displayedTotals.totalCents)}
              </strong>
            </div>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={reset}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#d4d5cf] px-5 text-sm font-semibold text-[#526159] transition hover:bg-[#f3f4f0]"
            >
              <RotateCcw className="size-4" /> Recommencer
            </button>
            {stage === 'draft' ? (
              <button
                type="button"
                disabled={!complete}
                onClick={() => setStage('accepted')}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#e79b2f] px-5 text-sm font-semibold text-[#1f3127] transition hover:bg-[#efa944] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Accepter le devis <CheckCircle2 className="size-4" />
              </button>
            ) : stage === 'accepted' ? (
              <button
                type="button"
                onClick={() => {
                  setDeliveredQuantity(quantity);
                  setStage('order');
                }}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white transition hover:bg-[#24563f]"
              >
                Créer la commande <ArrowRight className="size-4" />
              </button>
            ) : stage === 'order' ? (
              <button
                type="button"
                disabled={!deliveryReady}
                onClick={() => setStage('delivery')}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white transition hover:bg-[#24563f] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Émettre le bon de livraison <Truck className="size-4" />
              </button>
            ) : stage === 'delivery' ? (
              <button
                type="button"
                onClick={() => setStage('invoice')}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white transition hover:bg-[#24563f]"
              >
                Créer la facture {fullDelivery ? 'finale' : 'de situation'}{' '}
                <ArrowRight className="size-4" />
              </button>
            ) : (
              <p className="text-right text-sm font-semibold text-[#35694b]" aria-live="polite">
                {fullDelivery ? 'Facture finale' : 'Situation'} créée sans
                ressaisie ni double sortie de stock.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
