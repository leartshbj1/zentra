'use client';

import {
  BellRing,
  CheckCircle2,
  FileText,
  Mail,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { useState } from 'react';

const LEVELS = [
  {
    level: 1,
    delay: 7,
    label: 'Rappel amical',
    subject: 'Rappel amical · facture',
    introduction: 'Sauf erreur de notre part, le solde reste ouvert.',
  },
  {
    level: 2,
    delay: 21,
    label: 'Première relance',
    subject: 'Première relance · facture',
    introduction: 'Le solde reste ouvert malgré notre précédent rappel.',
  },
  {
    level: 3,
    delay: 35,
    label: 'Dernière relance',
    subject: 'Dernière relance · facture',
    introduction:
      'Le solde reste ouvert. Toute démarche ultérieure nécessite une décision séparée.',
  },
] as const;

function addDays(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string) {
  if (!value) return 'date à contrôler';
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'date à contrôler';
  return new Intl.DateTimeFormat('fr-CH', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function cents(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('fr-CH', {
    style: 'currency',
    currency: 'CHF',
  }).format(value / 100);
}

export function ReminderDemo() {
  const [invoiceNumber, setInvoiceNumber] = useState('F-2026-0042');
  const [clientName, setClientName] = useState('Atelier du Lac Sàrl');
  const [total, setTotal] = useState('2180.00');
  const [paidAmount, setPaidAmount] = useState('500.00');
  const [dueDate, setDueDate] = useState('2026-08-15');
  const [level, setLevel] = useState<1 | 2 | 3>(1);
  const [settled, setSettled] = useState(false);

  const selected = LEVELS[level - 1];
  const totalCents = cents(total);
  const enteredPaidCents = cents(paidAmount);
  const amountsValid =
    totalCents !== null && (settled || enteredPaidCents !== null);
  const paidCents = amountsValid
    ? settled
      ? totalCents!
      : Math.min(enteredPaidCents!, totalCents!)
    : null;
  const balanceCents =
    amountsValid && paidCents !== null
      ? Math.max(0, totalCents! - paidCents)
      : null;
  const cycleStopped = amountsValid && (settled || balanceCents === 0);
  const reminderDate = addDays(dueDate, selected.delay);
  const paymentDeadline = addDays(reminderDate, 10);
  const safeInvoiceNumber = invoiceNumber.trim() || 'votre facture';
  const safeClientName = clientName.trim() || 'votre client';

  const preview = {
    subject: `${selected.subject} ${safeInvoiceNumber}`,
    body: `Bonjour ${safeClientName},\n\n${selected.introduction} Le montant actuellement dû pour la facture ${safeInvoiceNumber}, échue le ${formatDate(dueDate)}, est de ${balanceCents === null ? 'un montant à contrôler' : formatMoney(balanceCents)}.\n\nMerci d’effectuer le règlement d’ici au ${formatDate(paymentDeadline)} ou de nous signaler tout paiement déjà réalisé.\n\nAvec nos salutations,\nVotre entreprise`,
  };

  return (
    <div className="reminder-demo mt-12 overflow-hidden rounded-[30px] border border-[#cfd8d1] bg-[#f8faf8] shadow-[0_30px_80px_rgba(27,66,45,.12)]">
      <div className="grid gap-px bg-[#dbe2dc] xl:grid-cols-[.86fr_1.14fr]">
        <div className="bg-[#f8faf8] p-5 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[.13em] text-[#427055]">
                Démonstration locale
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-[-.035em]">
                Préparez une relance en 3 étapes.
              </h3>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#cadecf] bg-white px-3 py-2 text-[11px] font-semibold text-[#42604f]">
              <ShieldCheck className="size-3.5" /> Rien n’est envoyé
            </span>
          </div>

          <ol className="mt-7 grid gap-2 sm:grid-cols-3" aria-label="Étapes de la démonstration">
            {[
              ['01', 'Vérifier'],
              ['02', 'Choisir'],
              ['03', 'Relire'],
            ].map(([number, label]) => (
              <li
                key={number}
                className="rounded-2xl border border-[#d8dfd9] bg-white px-4 py-3"
              >
                <span className="text-[10px] font-bold text-[#a36b24]">{number}</span>
                <strong className="ml-2 text-xs text-[#31483a]">{label}</strong>
              </li>
            ))}
          </ol>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-xs font-semibold text-[#405247]">
              Numéro de facture
              <input
                value={invoiceNumber}
                maxLength={40}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                className="min-h-11 rounded-xl border border-[#cad4cc] bg-white px-3 font-normal outline-none transition focus:border-[#5b876b]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#405247]">
              Client
              <input
                value={clientName}
                maxLength={80}
                onChange={(event) => setClientName(event.target.value)}
                className="min-h-11 rounded-xl border border-[#cad4cc] bg-white px-3 font-normal outline-none transition focus:border-[#5b876b]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#405247]">
              Total de la facture (CHF)
              <input
                inputMode="decimal"
                value={total}
                aria-invalid={totalCents === null}
                onChange={(event) => setTotal(event.target.value)}
                className="min-h-11 rounded-xl border border-[#cad4cc] bg-white px-3 font-normal outline-none transition focus:border-[#5b876b]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#405247]">
              Déjà encaissé (CHF)
              <input
                inputMode="decimal"
                value={paidAmount}
                disabled={settled}
                aria-invalid={!settled && enteredPaidCents === null}
                onChange={(event) => setPaidAmount(event.target.value)}
                className="min-h-11 rounded-xl border border-[#cad4cc] bg-white px-3 font-normal outline-none transition focus:border-[#5b876b] disabled:bg-[#edf1ee]"
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[#405247] sm:col-span-2">
              Échéance initiale
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="min-h-11 rounded-xl border border-[#cad4cc] bg-white px-3 font-normal outline-none transition focus:border-[#5b876b]"
              />
            </label>
          </div>

          <fieldset className="mt-6">
            <legend className="text-xs font-semibold text-[#405247]">
              Niveau à prévisualiser
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {LEVELS.map((item) => (
                <button
                  key={item.level}
                  type="button"
                  aria-pressed={level === item.level}
                  onClick={() => setLevel(item.level)}
                  className={`min-h-14 rounded-xl border px-3 text-left transition ${
                    level === item.level
                      ? 'border-[#2f6748] bg-[#e6f0e8] text-[#214b35] shadow-sm'
                      : 'border-[#d5ddd7] bg-white text-[#657169] hover:border-[#9caf9f]'
                  }`}
                >
                  <strong className="block text-xs">Niveau {item.level}</strong>
                  <span className="mt-0.5 block text-[10px]">J+{item.delay}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="mt-5 flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-[#d6ddd7] bg-white px-4 text-xs font-semibold text-[#405247]">
            <input
              type="checkbox"
              checked={settled}
              onChange={(event) => setSettled(event.target.checked)}
              className="size-4 accent-[#2f6748]"
            />
            Simuler le règlement complet avant la préparation
          </label>
        </div>

        <div className="bg-white p-5 sm:p-8">
          <p className="sr-only" aria-live="polite">
            {!amountsValid
              ? 'Les montants doivent être corrigés.'
              : cycleStopped
                ? 'La facture est soldée, la relance s’arrête.'
                : `Aperçu du niveau ${level} prêt à relire.`}
          </p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[.13em] text-[#95621f]">
                Résultat contrôlé
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-[-.035em]">
                {!amountsValid
                  ? 'Corrigez les montants.'
                  : cycleStopped
                  ? 'La relance s’arrête.'
                  : 'Votre courrier est prêt à relire.'}
              </h3>
            </div>
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold ${
                cycleStopped
                  ? 'bg-[#e7f3e9] text-[#2d6843]'
                  : 'bg-[#fff2dc] text-[#805519]'
              }`}
            >
              {cycleStopped ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <BellRing className="size-3.5" />
              )}
              {!amountsValid
                ? 'Saisie à corriger'
                : cycleStopped
                  ? 'Facture soldée'
                  : selected.label}
            </span>
          </div>

          {!amountsValid ? (
            <div
              className="mt-8 rounded-[24px] border border-[#e3c9a1] bg-[#fff7e8] p-6 text-[#704f20]"
              role="alert"
            >
              <strong className="block text-lg">Montant à contrôler</strong>
              <p className="mt-2 text-sm leading-6">
                Utilisez uniquement des chiffres avec au maximum deux décimales,
                par exemple 2180.00. Aucun aperçu n’est considéré comme prêt
                tant que la saisie est invalide.
              </p>
            </div>
          ) : cycleStopped ? (
            <div className="mt-8 rounded-[24px] border border-[#cce0d1] bg-[#edf7ef] p-6 text-[#315f43]">
              <WalletCards className="size-7" />
              <strong className="mt-5 block text-lg">
                Aucun message ne serait préparé.
              </strong>
              <p className="mt-2 text-sm leading-6">
                Zentra revérifie le solde au dernier moment, arrête la relance et
                conserve l’événement dans l’historique local.
              </p>
            </div>
          ) : (
            <div className="mt-7 overflow-hidden rounded-[24px] border border-[#d9ded9] bg-[#fbfcfb] shadow-[0_18px_45px_rgba(38,67,49,.08)]">
              <div className="flex items-center justify-between gap-3 border-b border-[#e0e5e1] bg-white px-5 py-4">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-[#385140]">
                  <Mail className="size-4 text-[#4b7b5b]" /> Aperçu avant envoi
                </span>
                <span className="text-[10px] font-semibold text-[#748078]">
                  Solde revérifié
                </span>
              </div>
              <div className="space-y-4 p-5 text-sm leading-7 text-[#536159] sm:p-7">
                <div>
                  <span className="block text-[10px] font-semibold uppercase tracking-[.11em] text-[#849087]">
                    Objet
                  </span>
                  <strong className="mt-1 block text-[#263a2e]">
                    {preview.subject}
                  </strong>
                </div>
                <div className="whitespace-pre-line rounded-2xl bg-white p-4 text-xs leading-6 shadow-sm sm:p-5">
                  {preview.body}
                </div>
              </div>
            </div>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#dde3de] bg-[#f7f9f7] p-4">
              <FileText className="size-4 text-[#4a7659]" />
              <strong className="mt-3 block text-xs text-[#344b3c]">
                Préparation prévue
              </strong>
              <span className="mt-1 block text-xs text-[#68756d]">
                {formatDate(reminderDate)} · solde{' '}
                {balanceCents === null ? 'à contrôler' : formatMoney(balanceCents)}
              </span>
            </div>
            <div className="rounded-2xl border border-[#dde3de] bg-[#f7f9f7] p-4">
              <ShieldCheck className="size-4 text-[#4a7659]" />
              <strong className="mt-3 block text-xs text-[#344b3c]">
                Décision humaine
              </strong>
              <span className="mt-1 block text-xs text-[#68756d]">
                Brouillon, impression ou envoi à confirmer.
              </span>
            </div>
          </div>
        </div>
      </div>
      <p className="border-t border-[#dbe2dc] bg-[#f0f4f1] px-5 py-4 text-[11px] leading-5 text-[#657169] sm:px-8">
        Exemple fictif exécuté uniquement dans ce navigateur&nbsp;: aucune donnée
        n’est conservée, aucun e-mail n’est créé et aucune poursuite n’est
        engagée. Dans l’application, les données réelles restent sur le PC du
        client.
      </p>
    </div>
  );
}
