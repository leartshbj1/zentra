'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  FileCheck2,
  Receipt,
  RotateCcw,
} from 'lucide-react';

type DemoStage = 'draft' | 'accepted' | 'invoice';

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

  const complete =
    description.trim().length > 0 &&
    numberValue(quantity) > 0 &&
    unitPrice.trim() !== '' &&
    numberValue(unitPrice) >= 0 &&
    vatRate !== '';
  const locked = stage === 'invoice';

  function edit(setter: (value: string) => void, value: string) {
    setter(value);
    setStage('draft');
  }

  function reset() {
    setDescription('');
    setQuantity('');
    setUnitPrice('');
    setDiscount('');
    setVatRate('');
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
            Du devis accepté à la facture, en un clic.
          </h3>
          <p className="mt-4 text-sm leading-6 text-white/72">
            Saisissez votre propre ligne. Cet exemple ne contient aucune donnée
            d’entreprise préchargée.
          </p>
          <ol className="mt-8 grid gap-3" aria-label="Étapes de la démonstration">
            {[
              ['draft', '1', 'Préparer le devis'],
              ['accepted', '2', 'Confirmer l’acceptation'],
              ['invoice', '3', 'Créer la facture'],
            ].map(([id, number, label]) => {
              const reached =
                id === 'draft' ||
                (id === 'accepted' && stage !== 'draft') ||
                (id === 'invoice' && stage === 'invoice');
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
                    {reached && id !== 'draft' ? (
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
                ) : (
                  <FileCheck2 className="size-5" />
                )}
              </span>
              <div>
                <p className="font-semibold text-[#253b2f]">
                  {stage === 'invoice'
                    ? 'Facture brouillon créée'
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
                stage === 'invoice'
                  ? 'bg-[#e6f1e8] text-[#2f6847]'
                  : stage === 'accepted'
                    ? 'bg-[#fff0d8] text-[#865819]'
                    : 'bg-[#eef0ed] text-[#58645d]'
              }`}
              aria-live="polite"
            >
              {stage === 'invoice'
                ? 'FACTURE BROUILLON'
                : stage === 'accepted'
                  ? 'DEVIS ACCEPTÉ'
                  : 'DEVIS BROUILLON'}
            </span>
          </div>

          <fieldset disabled={locked} className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-xs font-semibold text-[#526159] sm:col-span-2">
              Description de votre prestation
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

          <div className="mt-6 grid gap-5 rounded-2xl bg-[#f3f4f0] p-5 sm:grid-cols-[1fr_auto] sm:items-end">
            <dl className="grid gap-2 text-sm text-[#637068]">
              <div className="flex justify-between gap-4">
                <dt>Sous-total</dt>
                <dd>{money(totals.beforeDiscountCents)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Remise</dt>
                <dd>− {money(totals.discountCents)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>TVA</dt>
                <dd>{money(totals.vatCents)}</dd>
              </div>
            </dl>
            <div className="border-t border-[#d9dcd7] pt-4 text-right sm:min-w-44 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
              <span className="block text-xs text-[#6d7871]">Total TTC</span>
              <strong className="mt-1 block text-2xl tracking-[-.04em] text-[#244231]">
                {money(totals.totalCents)}
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
                onClick={() => setStage('invoice')}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#173d2c] px-5 text-sm font-semibold text-white transition hover:bg-[#24563f]"
              >
                Créer la facture <ArrowRight className="size-4" />
              </button>
            ) : (
              <p className="text-right text-sm font-semibold text-[#35694b]" aria-live="polite">
                Conversion terminée sans ressaisie.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
