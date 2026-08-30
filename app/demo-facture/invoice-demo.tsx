'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { CircleAlert, FileText, Plus, Printer, QrCode, ShieldCheck, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

type Party = {
  name: string;
  uid: string;
  street: string;
  building: string;
  postalCode: string;
  city: string;
  country: string;
};

type InvoiceLine = {
  id: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: string;
};

const emptyParty: Party = {
  name: '',
  uid: '',
  street: '',
  building: '',
  postalCode: '',
  city: '',
  country: '',
};

const swissCross =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" fill="%23000"/%3E%3Cpath d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" fill="%23fff"/%3E%3C/svg%3E';

const isoCountryCodes = new Set(
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '),
);

const spcTextPattern = /^[\u0020-\u007E\u00A0-\u00FF\u0100-\u017F\u0218-\u021B\u20AC]*$/u;

function normalizeSpc(value: string) {
  return value.normalize('NFC').trim();
}

function parsedNumber(value: string) {
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNumber(value: string) {
  return parsedNumber(value) ?? 0;
}

function money(value: number) {
  return new Intl.NumberFormat('fr-CH', {
    style: 'currency',
    currency: 'CHF',
    minimumFractionDigits: 2,
  }).format(value);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function cleanIban(value: string) {
  return value.replace(/\s/g, '').toUpperCase();
}

function validIban(value: string) {
  const iban = cleanIban(value);
  if (!/^(CH|LI)[0-9]{7}[A-Z0-9]{12}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

function isQrIban(value: string) {
  const iban = cleanIban(value);
  if (!validIban(iban)) return false;
  const iid = Number(iban.slice(4, 9));
  return iid >= 30000 && iid <= 31999;
}

function validSwissUid(value: string) {
  const canonical = value.normalize('NFC').trim().toUpperCase().replace(/\s*(MWST|TVA|IVA)$/, '');
  if (!/^CHE[- ]?\d{3}(?:\.?\d{3}){2}$/.test(canonical)) return false;
  const digits = canonical.replace(/\D/g, '');
  const weights = [5, 4, 3, 2, 7, 6, 5, 4];
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
  const remainder = 11 - (sum % 11);
  const check = remainder === 11 ? 0 : remainder;
  return check !== 10 && check === Number(digits[8]);
}

function validSpcText(value: string) {
  return spcTextPattern.test(value.normalize('NFC'));
}

function modulo10Recursive(value: string) {
  const table = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];
  let carry = 0;
  for (const digit of value) carry = table[(carry + Number(digit)) % 10];
  return String((10 - carry) % 10);
}

function makeQrReference(invoiceNumber: string) {
  const digits = invoiceNumber.replace(/\D/g, '');
  if (!digits || /^0+$/.test(digits)) return '';
  const body = digits.slice(-26).padStart(26, '0');
  return `${body}${modulo10Recursive(body)}`;
}

function addressLines(party: Party) {
  return [
    'S',
    normalizeSpc(party.name),
    normalizeSpc(party.street),
    normalizeSpc(party.building),
    normalizeSpc(party.postalCode),
    normalizeSpc(party.city),
    normalizeSpc(party.country).toUpperCase(),
  ];
}

function buildSpcPayload(input: {
  iban: string;
  creditor: Party;
  debtor: Party;
  total: number;
  invoiceNumber: string;
}) {
  const qrIban = isQrIban(input.iban);
  const reference = qrIban ? makeQrReference(input.invoiceNumber) : '';
  const message = normalizeSpc(`Facture ${input.invoiceNumber}`).slice(0, 140);
  return [
    'SPC',
    '0200',
    '1',
    cleanIban(input.iban),
    ...addressLines(input.creditor),
    '', '', '', '', '', '', '',
    input.total.toFixed(2),
    'CHF',
    ...addressLines(input.debtor),
    qrIban ? 'QRR' : 'NON',
    reference,
    message,
    'EPD',
  ].join('\n');
}

function Field({ label, value, onChange, type = 'text', hint, required = false, invalid = false, maxLength }: { label: string; value: string; onChange: (value: string) => void; type?: string; hint?: string; required?: boolean; invalid?: boolean; maxLength?: number }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label htmlFor={id} className="grid gap-1.5 text-sm font-medium text-[#2c3c33]">
      {label}
      <input
        id={id}
        type={type}
        step={type === 'number' ? 'any' : undefined}
        inputMode={type === 'number' ? 'decimal' : undefined}
        required={required}
        maxLength={maxLength}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 rounded-xl border border-[#d8d4ca] bg-white px-3 font-normal outline-none transition focus:border-[#4f765f] focus:ring-2 focus:ring-[#4f765f]/15"
      />
      {hint ? <span id={hintId} className="text-xs font-normal leading-5 text-[#7c857e]">{hint}</span> : null}
    </label>
  );
}

function PartyFields({ title, party, onChange, showUid }: { title: string; party: Party; onChange: (party: Party) => void; showUid?: boolean }) {
  const set = (key: keyof Party, value: string) => onChange({ ...party, [key]: value });
  return (
    <fieldset className="rounded-2xl border border-[#ddd8cd] p-4 sm:p-5">
      <legend className="px-2 text-sm font-semibold">{title}</legend>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field label="Nom légal" value={party.name} onChange={(value) => set('name', value)} required invalid={!party.name.trim()} maxLength={70} />
        {showUid ? <Field label="IDE / numéro TVA" value={party.uid} onChange={(value) => set('uid', value)} hint="Format suisse attendu : CHE-123.456.789 TVA." invalid={Boolean(party.uid.trim()) && !validSwissUid(party.uid)} maxLength={24} /> : null}
        <Field label="Rue" value={party.street} onChange={(value) => set('street', value)} maxLength={70} />
        <Field label="Numéro" value={party.building} onChange={(value) => set('building', value)} maxLength={16} />
        <Field label="NPA" value={party.postalCode} onChange={(value) => set('postalCode', value)} required invalid={!party.postalCode.trim()} maxLength={16} />
        <Field label="Localité" value={party.city} onChange={(value) => set('city', value)} required invalid={!party.city.trim()} maxLength={35} />
        <Field label="Pays (ISO, 2 lettres)" value={party.country} onChange={(value) => set('country', value.toUpperCase().slice(0, 2))} required invalid={Boolean(party.country) && !isoCountryCodes.has(party.country.toUpperCase())} maxLength={2} />
      </div>
    </fieldset>
  );
}

export function InvoiceDemo() {
  const nextLine = useRef(2);
  const [supplier, setSupplier] = useState<Party>(emptyParty);
  const [customer, setCustomer] = useState<Party>(emptyParty);
  const [invoice, setInvoice] = useState({ number: '', issueDate: '', servicePeriod: '', dueDate: '', iban: '', note: '' });
  const [lines, setLines] = useState<InvoiceLine[]>([
    { id: 'line-1', description: '', quantity: '', unit: '', unitPrice: '', vatRate: '' },
  ]);

  const totals = useMemo(() => {
    const details = lines.map((line) => {
      const net = roundMoney(readNumber(line.quantity) * readNumber(line.unitPrice));
      const vat = roundMoney(net * (readNumber(line.vatRate) / 100));
      return { ...line, net, vat, gross: roundMoney(net + vat) };
    });
    const vatGroups = new Map<number, { rate: number; base: number; vat: number }>();
    for (const line of details) {
      const rate = parsedNumber(line.vatRate) ?? 0;
      const current = vatGroups.get(rate) ?? { rate, base: 0, vat: 0 };
      current.base = roundMoney(current.base + line.net);
      current.vat = roundMoney(current.vat + line.vat);
      vatGroups.set(rate, current);
    }
    return {
      details,
      net: roundMoney(details.reduce((sum, line) => sum + line.net, 0)),
      vat: roundMoney(details.reduce((sum, line) => sum + line.vat, 0)),
      gross: roundMoney(details.reduce((sum, line) => sum + line.gross, 0)),
      vatBreakdown: [...vatGroups.values()].sort((a, b) => a.rate - b.rate),
    };
  }, [lines]);

  const qrErrors = useMemo(() => {
    const errors: string[] = [];
    if (!validIban(invoice.iban)) errors.push('Saisissez un IBAN suisse ou liechtensteinois valide.');
    for (const [name, party] of [['émetteur', supplier], ['client', customer]] as const) {
      if (!party.name.trim() || !party.postalCode.trim() || !party.city.trim() || !isoCountryCodes.has(party.country.trim().toUpperCase())) {
        errors.push(`Complétez le nom, le NPA, la localité et le pays structuré pour ${name}.`);
      }
      if (normalizeSpc(party.name).length > 70 || normalizeSpc(party.street).length > 70 || normalizeSpc(party.building).length > 16 || normalizeSpc(party.postalCode).length > 16 || normalizeSpc(party.city).length > 35) {
        errors.push(`Une donnée d’adresse pour ${name} dépasse la longueur admise par le format SPC.`);
      }
      if (![party.name, party.street, party.building, party.postalCode, party.city, party.country].every(validSpcText)) {
        errors.push(`Une donnée d’adresse pour ${name} contient un caractère non admis dans le Swiss QR Code.`);
      }
    }
    if (totals.gross <= 0) errors.push('Le total doit être supérieur à zéro.');
    if (totals.gross > 999_999_999.99) errors.push('Le total dépasse le maximum admis par la QR-facture.');
    if (lines.some((line) => !line.description.trim() || parsedNumber(line.quantity) === null || (parsedNumber(line.quantity) ?? 0) <= 0 || parsedNumber(line.unitPrice) === null || (parsedNumber(line.unitPrice) ?? -1) < 0 || parsedNumber(line.vatRate) === null || (parsedNumber(line.vatRate) ?? -1) < 0 || (parsedNumber(line.vatRate) ?? 101) > 100)) {
      errors.push('Chaque ligne doit avoir une description, une quantité positive, un prix non négatif et un taux TVA explicitement renseigné entre 0 et 100.');
    }
    if (!invoice.number.trim()) errors.push('Le numéro de facture est requis.');
    if (invoice.number && !validSpcText(invoice.number)) errors.push('Le numéro de facture contient un caractère non admis dans le Swiss QR Code.');
    if (!invoice.issueDate) errors.push('La date d’émission est requise.');
    if (!invoice.servicePeriod.trim()) errors.push('La date ou période de prestation est requise.');
    if (!invoice.dueDate) errors.push('L’échéance de paiement est requise.');
    if (invoice.issueDate && invoice.dueDate && invoice.dueDate < invoice.issueDate) errors.push('L’échéance ne peut pas précéder la date d’émission.');
    if (supplier.uid.trim() && !validSwissUid(supplier.uid)) errors.push('Le numéro IDE/TVA saisi doit être un numéro suisse valide au format CHE-123.456.789 TVA.');
    if (lines.some((line) => (parsedNumber(line.vatRate) ?? 0) > 0) && !supplier.uid.trim()) errors.push('Le numéro TVA suisse de l’émetteur est requis lorsqu’une TVA est facturée.');
    if (invoice.number.length > 40 || invoice.servicePeriod.length > 60 || invoice.note.length > 180 || lines.some((line) => line.description.length > 100 || line.unit.length > 16)) errors.push('Le contenu dépasse le gabarit A4 de cette démonstration. Raccourcissez le numéro, la période, la note ou les lignes.');
    if (isQrIban(invoice.iban) && !makeQrReference(invoice.number)) errors.push('Un numéro contenant des chiffres est requis pour la référence QR.');
    if (!errors.length) {
      const candidate = buildSpcPayload({ iban: invoice.iban, creditor: supplier, debtor: customer, total: totals.gross, invoiceNumber: invoice.number });
      if (candidate.length > 997) errors.push('Le contenu dépasse la longueur maximale du Swiss QR Code.');
      if (!validSpcText(candidate.replace(/\n/g, ''))) errors.push('Le contenu QR contient un caractère non admis par la norme SPC.');
    }
    return errors;
  }, [customer, invoice, lines, supplier, totals.gross]);

  const payload = qrErrors.length
    ? ''
    : buildSpcPayload({ iban: invoice.iban, creditor: supplier, debtor: customer, total: totals.gross, invoiceNumber: invoice.number });
  const qrReference = isQrIban(invoice.iban) ? makeQrReference(invoice.number) : '';

  const updateInvoice = (key: keyof typeof invoice, value: string) => setInvoice((current) => ({ ...current, [key]: value }));
  const updateLine = (id: string, key: keyof Omit<InvoiceLine, 'id'>, value: string) => setLines((current) => current.map((line) => line.id === id ? { ...line, [key]: value } : line));

  const addLine = () => {
    if (lines.length >= 3) return;
    const id = `line-${nextLine.current++}`;
    setLines((current) => [...current, { id, description: '', quantity: '', unit: '', unitPrice: '', vatRate: '' }]);
  };

  return (
    <section className="invoice-demo mx-auto grid max-w-[1500px] gap-7 px-5 pb-20 xl:grid-cols-[minmax(420px,.78fr)_minmax(650px,1.22fr)] xl:px-8">
      <div className="print-hidden self-start rounded-[26px] border border-[#d9d4c9] bg-white p-5 shadow-[0_20px_55px_rgba(32,48,38,.08)] sm:p-7 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">
        <div className="flex items-center gap-3"><FileText className="size-5 text-[#a5661c]" /><h2 className="text-xl font-semibold">Informations de la facture</h2></div>
        <div className="mt-6 space-y-5">
          <PartyFields title="Émetteur" party={supplier} onChange={setSupplier} showUid />
          <PartyFields title="Client" party={customer} onChange={setCustomer} />
          <fieldset className="rounded-2xl border border-[#ddd8cd] p-4 sm:p-5">
            <legend className="px-2 text-sm font-semibold">Document et paiement</legend>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <Field label="Numéro de facture" value={invoice.number} onChange={(value) => updateInvoice('number', value)} required invalid={!invoice.number.trim()} maxLength={40} />
              <Field label="Date d’émission" type="date" value={invoice.issueDate} onChange={(value) => updateInvoice('issueDate', value)} required invalid={!invoice.issueDate} />
              <Field label="Date / période de prestation" value={invoice.servicePeriod} onChange={(value) => updateInvoice('servicePeriod', value)} required invalid={!invoice.servicePeriod.trim()} maxLength={60} />
              <Field label="Échéance" type="date" value={invoice.dueDate} onChange={(value) => updateInvoice('dueDate', value)} required invalid={!invoice.dueDate || Boolean(invoice.issueDate && invoice.dueDate < invoice.issueDate)} />
              <div className="sm:col-span-2"><Field label="IBAN de paiement" value={invoice.iban} onChange={(value) => updateInvoice('iban', value)} required invalid={Boolean(invoice.iban) && !validIban(invoice.iban)} /></div>
              <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">Note<textarea maxLength={180} value={invoice.note} onChange={(event) => updateInvoice('note', event.target.value)} className="min-h-24 rounded-xl border border-[#d8d4ca] bg-white p-3 font-normal outline-none focus:border-[#4f765f] focus:ring-2 focus:ring-[#4f765f]/15" /><span className="text-xs font-normal text-[#7c857e]">180 caractères maximum pour préserver le gabarit A4.</span></label>
            </div>
          </fieldset>
          <fieldset className="rounded-2xl border border-[#ddd8cd] p-4 sm:p-5">
            <legend className="px-2 text-sm font-semibold">Prestations</legend>
            <div className="mt-2 space-y-4">
              {lines.map((line, index) => (
                <div key={line.id} className="rounded-xl bg-[#f7f5f0] p-3">
                  <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold text-[#8a6131]">LIGNE {index + 1}</span>{lines.length > 1 ? <button type="button" aria-label={`Supprimer la ligne ${index + 1}`} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} className="grid size-8 place-items-center rounded-lg text-[#8b4f3f] hover:bg-white"><Trash2 className="size-4" /></button> : null}</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2"><Field label="Description" value={line.description} onChange={(value) => updateLine(line.id, 'description', value)} required invalid={!line.description.trim()} maxLength={100} /></div>
                    <Field label="Quantité" type="number" value={line.quantity} onChange={(value) => updateLine(line.id, 'quantity', value)} required invalid={parsedNumber(line.quantity) !== null && (parsedNumber(line.quantity) ?? 0) <= 0} />
                    <Field label="Unité" value={line.unit} onChange={(value) => updateLine(line.id, 'unit', value)} maxLength={16} />
                    <Field label="Prix unitaire CHF" type="number" value={line.unitPrice} onChange={(value) => updateLine(line.id, 'unitPrice', value)} required invalid={parsedNumber(line.unitPrice) !== null && (parsedNumber(line.unitPrice) ?? 0) < 0} />
                    <Field label="TVA %" type="number" value={line.vatRate} onChange={(value) => updateLine(line.id, 'vatRate', value)} required invalid={parsedNumber(line.vatRate) !== null && ((parsedNumber(line.vatRate) ?? 0) < 0 || (parsedNumber(line.vatRate) ?? 0) > 100)} />
                  </div>
                </div>
              ))}
              <button type="button" onClick={addLine} disabled={lines.length >= 3} className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#bfb9ad] text-sm font-semibold text-[#45604f] hover:bg-[#f7f5f0] disabled:cursor-not-allowed disabled:opacity-45"><Plus className="size-4" /> {lines.length >= 3 ? 'Maximum de 3 lignes pour cet aperçu A4' : 'Ajouter une ligne'}</button>
            </div>
          </fieldset>
        </div>
      </div>

      <div>
        <div className="print-hidden mb-4 flex flex-col gap-3 rounded-2xl bg-[#173d2c] p-4 text-white sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#efaa3c]" /><p className="text-sm leading-6 text-white/65">Aucune saisie n’est enregistrée ni envoyée. Cet outil illustre le document ; la validation finale dépend toujours des données réelles et de la situation fiscale de l’entreprise.</p></div>
          <button type="button" aria-describedby="invoice-errors" disabled={qrErrors.length > 0} onClick={() => window.print()} className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-[#efaa3c] px-5 text-sm font-semibold text-[#173d2c] disabled:cursor-not-allowed disabled:opacity-45"><Printer className="size-4" /> {qrErrors.length ? 'Compléter la facture' : 'Imprimer l’aperçu / PDF'}</button>
        </div>

        <article className="invoice-sheet mx-auto flex min-h-[297mm] w-full max-w-[210mm] flex-col bg-white text-[#111] shadow-[0_18px_60px_rgba(31,44,35,.12)]">
          <div className="invoice-main p-[12mm]">
            <header className="flex items-start justify-between gap-8 border-b border-black pb-8">
              <div><p className="text-2xl font-bold">{supplier.name || 'Votre entreprise'}</p><div className="mt-3 whitespace-pre-line text-sm leading-6 text-[#555]">{[`${supplier.street} ${supplier.building}`.trim(), `${supplier.postalCode} ${supplier.city}`.trim(), supplier.country, supplier.uid].filter(Boolean).join('\n') || 'Coordonnées à compléter'}</div></div>
              <div className="text-right"><p className="text-3xl font-light uppercase tracking-[.12em]">Facture</p><p className="mt-3 text-sm font-semibold">{invoice.number || 'Numéro à compléter'}</p></div>
            </header>

            <div className="mt-9 grid gap-8 sm:grid-cols-2">
              <div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#777]">Facturé à</p><p className="mt-2 font-semibold">{customer.name || 'Client à compléter'}</p><p className="mt-1 whitespace-pre-line text-sm leading-6 text-[#555]">{[`${customer.street} ${customer.building}`.trim(), `${customer.postalCode} ${customer.city}`.trim(), customer.country].filter(Boolean).join('\n')}</p></div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-5 gap-y-2 text-sm"><dt className="text-[#666]">Date d’émission</dt><dd>{invoice.issueDate || '—'}</dd><dt className="text-[#666]">Date / période de prestation</dt><dd>{invoice.servicePeriod || '—'}</dd><dt className="text-[#666]">Échéance</dt><dd>{invoice.dueDate || '—'}</dd></dl>
            </div>

            <div className="mt-10 overflow-x-auto border-y border-black">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead><tr className="border-b border-black text-[10px] uppercase tracking-[.1em]"><th className="py-3 pr-3">Prestation</th><th className="px-2 py-3 text-right">Qté</th><th className="px-2 py-3">Unité</th><th className="px-2 py-3 text-right">Prix</th><th className="px-2 py-3 text-right">TVA</th><th className="py-3 pl-3 text-right">Total HT</th></tr></thead>
                <tbody>{totals.details.map((line) => <tr key={line.id} className="border-b border-[#ddd] last:border-0"><td className="py-4 pr-3">{line.description || '—'}</td><td className="px-2 py-4 text-right">{line.quantity || '—'}</td><td className="px-2 py-4">{line.unit || '—'}</td><td className="px-2 py-4 text-right">{money(readNumber(line.unitPrice))}</td><td className="px-2 py-4 text-right">{line.vatRate === '' ? 'À renseigner' : `${line.vatRate}%`}</td><td className="py-4 pl-3 text-right font-medium">{money(line.net)}</td></tr>)}</tbody>
              </table>
            </div>

            <div className="ml-auto mt-7 max-w-sm">
              <dl className="grid grid-cols-[1fr_auto] gap-x-8 gap-y-2 text-sm">
                <dt>Sous-total</dt><dd>{money(totals.net)}</dd>
                {totals.vatBreakdown.map((group) => <div key={group.rate} className="col-span-2 grid grid-cols-subgrid"><dt>TVA {group.rate}% sur {money(group.base)}</dt><dd>{money(group.vat)}</dd></div>)}
                <dt className="mt-2 border-t border-black pt-3 text-base font-bold">Total</dt><dd className="mt-2 border-t border-black pt-3 text-base font-bold">{money(totals.gross)}</dd>
              </dl>
            </div>
            {invoice.note ? <p className="mt-8 whitespace-pre-line text-sm leading-6 text-[#555]">{invoice.note}</p> : null}

            <div id="invoice-errors" aria-live="polite" className={`demo-notice mt-8 rounded-xl p-4 text-sm ${qrErrors.length ? 'bg-[#fff4df] text-[#72501e]' : 'bg-[#edf5ef] text-[#315e48]'}`}>
              {qrErrors.length ? <><div className="flex items-center gap-2 font-semibold"><CircleAlert className="size-4" /> Document incomplet</div><ul className="mt-2 list-disc space-y-1 pl-5">{qrErrors.map((error) => <li key={error}>{error}</li>)}</ul></> : <p><strong>Aperçu prêt à imprimer.</strong> Il illustre le format QR-facture, mais ne constitue ni une certification SIX ni un conseil fiscal.</p>}
            </div>
          </div>

          {payload ? (
            <section className="qr-payment-section relative mt-auto grid min-h-[105mm] grid-cols-[62fr_148fr] bg-white text-black">
              <span aria-hidden="true" className="qr-cut-horizontal">✂</span>
              <span aria-hidden="true" className="qr-cut-vertical">✂</span>
              <div className="qr-receipt flex min-w-0 flex-col border-r border-dashed border-black p-[5mm]">
                <h2 className="text-[11pt] font-bold leading-none">Récépissé</h2>
                <div className="mt-[5mm] text-[8pt] leading-[1.25]"><p className="text-[6pt] font-bold">Compte / Payable à</p><p className="break-all">{cleanIban(invoice.iban)}</p><p>{supplier.name}</p><p>{`${supplier.street} ${supplier.building}`.trim()}</p><p>{`${supplier.postalCode} ${supplier.city}`.trim()} {supplier.country}</p></div>
                {qrReference ? <div className="mt-[3mm] text-[8pt] leading-[1.25]"><p className="text-[6pt] font-bold">Référence</p><p className="break-all">{qrReference}</p></div> : null}
                <div className="mt-[3mm] text-[8pt] leading-[1.25]"><p className="text-[6pt] font-bold">Payable par</p><p>{customer.name}</p><p>{`${customer.street} ${customer.building}`.trim()}</p><p>{`${customer.postalCode} ${customer.city}`.trim()} {customer.country}</p></div>
                <div className="mt-[3mm] grid grid-cols-[12mm_1fr] gap-[2mm] text-[8pt]"><div><p className="text-[6pt] font-bold">Monnaie</p><strong>CHF</strong></div><div><p className="text-[6pt] font-bold">Montant</p><strong>{totals.gross.toFixed(2)}</strong></div></div>
                <div className="mt-auto text-right text-[6pt] font-bold">Point de dépôt</div>
              </div>

              <div className="qr-payment-part min-w-0 p-[5mm]">
                <h2 className="text-[11pt] font-bold leading-none">Section paiement</h2>
                <div className="qr-payment-content mt-[5mm] grid items-start gap-[5mm] sm:grid-cols-[56mm_1fr]">
                  <div>
                    <div className="size-[56mm] bg-white p-[5mm]"><QRCodeSVG value={payload} level="M" size={174} marginSize={0} className="h-[46mm] w-[46mm]" imageSettings={{ src: swissCross, width: 26, height: 26, excavate: true }} /></div>
                    <div className="mt-[3mm] grid grid-cols-[12mm_1fr] gap-[2mm] text-[8pt]"><div><p className="text-[6pt] font-bold">Monnaie</p><strong>CHF</strong></div><div><p className="text-[6pt] font-bold">Montant</p><strong>{totals.gross.toFixed(2)}</strong></div></div>
                  </div>
                  <div className="grid gap-[3mm] text-[8pt] leading-[1.25]">
                    <div><p className="text-[6pt] font-bold">Compte / Payable à</p><p className="break-all">{cleanIban(invoice.iban)}</p><p>{supplier.name}</p><p>{`${supplier.street} ${supplier.building}`.trim()}</p><p>{`${supplier.postalCode} ${supplier.city}`.trim()} {supplier.country}</p></div>
                    {qrReference ? <div><p className="text-[6pt] font-bold">Référence</p><p className="break-all">{qrReference}</p></div> : null}
                    <div><p className="text-[6pt] font-bold">Informations supplémentaires</p><p>Facture {invoice.number}</p></div>
                    <div><p className="text-[6pt] font-bold">Payable par</p><p>{customer.name}</p><p>{`${customer.street} ${customer.building}`.trim()}</p><p>{`${customer.postalCode} ${customer.city}`.trim()} {customer.country}</p></div>
                  </div>
                </div>
              </div>
            </section>
          ) : <div className="qr-payment-section mt-auto grid min-h-[105mm] place-items-center border-t border-dashed border-black bg-[#fafafa] p-8 text-center text-sm text-[#666]"><div><QrCode className="mx-auto mb-3 size-6" /><p>La bande QR de 210 × 105 mm apparaîtra lorsque toutes les données obligatoires seront valides.</p></div></div>}
        </article>
      </div>
    </section>
  );
}
