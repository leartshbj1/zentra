import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { posApi, type PosDay, type PosLineInput, type PosPaymentMethod, type PosTicket, type PosTicketLine } from './openApi';
import { cartTotals, cashSuggestions, centsFromText, keptSales, lineAmounts, receiptHtml } from './pos';
import { localDate } from './cashBook';
import { t, useAppLanguage } from './language';
import type { CatalogItem, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatMoney } from './utils';
import './erp-registers.css';
import './pos.css';

type CartLine = PosLineInput & Readonly<{ key: string }>;
type Payment = Readonly<{ method: PosPaymentMethod; reference: string; url: string }>;

const createId = () => crypto.randomUUID();
const METHOD_LABEL: Record<PosPaymentMethod, string> = { cash: 'Espèces', payrexx: 'TWINT ou carte', terminal: 'Terminal de carte' };

/**
 * Comptoir : vendre au comptoir ou à l'atelier, encaisser en espèces, TWINT ou
 * carte, imprimer le ticket. Le soir, la clôture crée la facture payée des
 * ventes du jour (TVA et comptabilité habituelles).
 */
export function PosPanel({ workspace, disabled, payrexxEnabled, onCloseDay }: {
  workspace: Workspace; disabled: boolean; payrexxEnabled: boolean;
  onCloseDay: (day: PosDay) => Promise<boolean>;
}) {
  useAppLanguage();
  const today = localDate(new Date());
  const [day, setDay] = useState<PosDay | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [search, setSearch] = useState('');
  const [free, setFree] = useState({ description: '', price: '' });
  const [received, setReceived] = useState('');
  const [payment, setPayment] = useState<Payment | null>(null);
  const [last, setLast] = useState<{ ticket: PosTicket; lines: PosTicketLine[]; shortfalls: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(createId());
  const defaultVat = workspace.settings?.billing.vatRatesBp?.[0] ?? 810;
  const vatRegistered = workspace.settings?.organization.vatRegistered !== false;
  const locked = disabled || busy;
  const closed = !!day?.closing;

  const reload = useCallback(async () => {
    try { setDay(await posApi.day(today)); } catch (reason) { setError(errorMessage(reason, t('La caisse du jour n’a pas pu être lue.'))); }
  }, [today]);
  useEffect(() => { void reload(); }, [reload]);

  const articles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workspace.catalogItems
      .filter((item) => !item.archivedAt && (!query || item.name.toLowerCase().includes(query) || (item.sku ?? '').toLowerCase().includes(query)))
      .slice(0, 24);
  }, [workspace.catalogItems, search]);
  const totals = cartTotals(cart);

  function add(item: CatalogItem) {
    setLast(null);
    setCart((lines) => {
      const existing = lines.find((line) => line.catalogItemId === item.id);
      if (existing) return lines.map((line) => line === existing ? { ...line, quantityMilli: line.quantityMilli + 1000 } : line);
      return [...lines, { key: createId(), catalogItemId: item.id, description: item.name, quantityMilli: 1000, unit: item.unit || 'pce', unitPriceCents: item.salesPriceCents, discountBp: 0, vatBp: vatRegistered ? item.vatBp : 0 }];
    });
  }

  function addFree() {
    const cents = centsFromText(free.price);
    if (!free.description.trim() || cents === null) { setError(t('Indiquez un libellé et un prix.')); return; }
    setError('');
    setCart((lines) => [...lines, { key: createId(), catalogItemId: null, description: free.description.trim(), quantityMilli: 1000, unit: 'pce', unitPriceCents: cents, discountBp: 0, vatBp: vatRegistered ? defaultVat : 0 }]);
    setFree({ description: '', price: '' });
  }

  function changeQuantity(key: string, delta: number) {
    setCart((lines) => lines.flatMap((line) => line.key !== key ? [line] : line.quantityMilli + delta <= 0 ? [] : [{ ...line, quantityMilli: line.quantityMilli + delta }]));
  }

  async function record(method: PosPaymentMethod, reference: string | null) {
    const receivedCents = method === 'cash' ? (received.trim() ? centsFromText(received) : totals.totalCents) : null;
    if (method === 'cash' && (receivedCents === null || receivedCents < totals.totalCents)) { setError(t('Le montant reçu est inférieur au total.')); return; }
    setBusy(true);
    setError('');
    try {
      const saved = await posApi.record({ requestId: requestId.current, date: today, method, currency: 'CHF', receivedCents, reference, lines: cart.map(({ key: _key, ...line }) => line) });
      requestId.current = createId();
      setLast(saved);
      setCart([]);
      setReceived('');
      setPayment(null);
      await reload();
    } catch (reason) {
      setError(errorMessage(reason, t('Le ticket n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }

  async function startPayrexx() {
    setBusy(true);
    setError('');
    try {
      const gateway = await posApi.createGateway(totals.totalCents, 'CHF');
      setPayment({ method: 'payrexx', reference: gateway.reference, url: gateway.url });
    } catch (reason) {
      setError(errorMessage(reason, t('Le paiement TWINT ou carte n’a pas pu être préparé.')));
    } finally {
      setBusy(false);
    }
  }

  // Le QR reste affiché jusqu'à la confirmation de Payrexx ; le ticket s'enregistre alors seul.
  useEffect(() => {
    if (payment?.method !== 'payrexx') return;
    let stop = false;
    const timer = window.setInterval(async () => {
      try {
        const status = await posApi.gatewayStatus(payment.reference);
        if (stop) return;
        if (status === 'paid') { stop = true; window.clearInterval(timer); await record('payrexx', payment.reference); }
        else if (status !== 'open') { stop = true; window.clearInterval(timer); setPayment(null); setError(t('Le paiement a été refusé ou annulé. Proposez un autre moyen de paiement.')); }
      } catch { /* nouvel essai au prochain passage */ }
    }, 3000);
    return () => { stop = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment]);

  function print(ticket: PosTicket, lines: readonly PosTicketLine[]) {
    const settings = workspace.settings, address = settings?.organization.address;
    const html = receiptHtml({
      company: settings?.organization.legalName || 'Zentra',
      address: [address?.street, [address?.postalCode, address?.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      vatNumber: settings?.organization.vatRegistered ? settings.organization.vatNumber : '',
      ticket, lines, money: (cents) => formatMoney(cents),
      labels: { total: t('Total'), vat: t('dont TVA'), received: t('Reçu'), change: t('Rendu'), method: t('Paiement'), thanks: t('Merci de votre visite.'),
        cash: t('Espèces'), payrexx: t('TWINT ou carte'), terminal: t('Terminal de carte') },
    });
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
    document.body.appendChild(frame);
    frame.srcdoc = html;
    frame.onload = () => { frame.contentWindow?.print(); window.setTimeout(() => frame.remove(), 60_000); };
  }

  async function voidTicket(ticket: PosTicket) {
    setBusy(true);
    setError('');
    try { await posApi.voidTicket(createId(), ticket.id); await reload(); }
    catch (reason) { setError(errorMessage(reason, t('Le ticket n’a pas pu être annulé.'))); }
    finally { setBusy(false); }
  }

  async function closeDay() {
    if (!day) return;
    setBusy(true);
    setError('');
    try { if (await onCloseDay(day)) await reload(); }
    finally { setBusy(false); }
  }

  const kept = day ? keptSales(day.tickets) : [];
  const voided = new Set(day?.tickets.filter((ticket) => ticket.kind === 'void').map((ticket) => ticket.voidsTicketId) ?? []);
  const receivedCents = received.trim() ? centsFromText(received) : null;

  return <section className="erp-register pos" aria-labelledby="pos-title">
    <h2 id="pos-title">{t('Comptoir')}</h2>
    <p>{t('Encaissez au comptoir ou à l’atelier. Chaque ticket sort les articles du stock ; le soir, la clôture crée la facture payée des ventes du jour.')}</p>
    {error ? <ErrorPanel message={error} /> : null}
    {closed ? <p role="status">{t('La caisse d’aujourd’hui est clôturée.')}</p> : null}
    {!closed ? <div className="pos__layout">
      <div className="pos__articles">
        <Field label={t('Article')}><input type="search" value={search} placeholder={t('Nom ou référence')} disabled={locked} onChange={(event) => setSearch(event.target.value)} /></Field>
        <ul className="pos__grid" aria-label={t('Articles')}>
          {articles.map((item) => <li key={item.id}><button type="button" disabled={locked} onClick={() => add(item)}>
            <span>{item.name}</span><small>{formatMoney(lineAmounts({ quantityMilli: 1000, unitPriceCents: item.salesPriceCents, discountBp: 0, vatBp: vatRegistered ? item.vatBp : 0 }).totalCents)}</small>
          </button></li>)}
        </ul>
        <div className="pos__free">
          <Field label={t('Libellé libre')}><input value={free.description} maxLength={300} disabled={locked} onChange={(event) => setFree({ ...free, description: event.target.value })} /></Field>
          <Field label={t('Prix hors TVA')}><input inputMode="decimal" placeholder="0.00" value={free.price} disabled={locked} onChange={(event) => setFree({ ...free, price: event.target.value })} /></Field>
          <Button variant="secondary" disabled={locked} onClick={addFree}>{t('Ajouter')}</Button>
        </div>
      </div>
      <div className="pos__cart" aria-live="polite">
        <h3>{t('Ticket')}</h3>
        {cart.length ? <ul className="erp-register__list">
          {cart.map((line) => <li key={line.key}>
            <span><strong>{line.description}</strong><small>{formatMoney(line.unitPriceCents)} {t('hors TVA')}</small></span>
            <span className="pos__quantity">
              <Button variant="ghost" size="small" disabled={locked} aria-label={t('Retirer un')} onClick={() => changeQuantity(line.key, -1000)}>−</Button>
              <span>{line.quantityMilli / 1000}</span>
              <Button variant="ghost" size="small" disabled={locked} aria-label={t('Ajouter un')} onClick={() => changeQuantity(line.key, 1000)}>+</Button>
              <strong>{formatMoney(lineAmounts(line).totalCents)}</strong>
            </span>
          </li>)}
        </ul> : <p>{t('Choisissez un article ou ajoutez une ligne libre.')}</p>}
        <div className="erp-register__figure"><strong>{formatMoney(totals.totalCents)}</strong><span>{t('dont TVA {amount}', { amount: formatMoney(totals.vatCents) })}</span></div>
        {payment ? <div className="pos__qr" role="status">
          <QRCodeSVG value={payment.url} size={196} marginSize={2} title={t('Paiement TWINT ou carte')} />
          <p>{t('Le client scanne le code avec TWINT ou son téléphone. Le ticket s’enregistre dès que Payrexx confirme le paiement.')}</p>
          <Button variant="ghost" disabled={busy} onClick={() => setPayment(null)}>{t('Annuler ce paiement')}</Button>
        </div> : cart.length ? <div className="pos__pay">
          <Field label={t('Reçu en espèces')}><input inputMode="decimal" placeholder={formatMoney(totals.totalCents)} value={received} disabled={locked} onChange={(event) => setReceived(event.target.value)} /></Field>
          <div className="erp-register__actions">
            {cashSuggestions(totals.totalCents).map((cents) => <Button key={cents} variant="ghost" size="small" disabled={locked} onClick={() => setReceived((cents / 100).toFixed(2))}>{formatMoney(cents)}</Button>)}
          </div>
          {receivedCents !== null && receivedCents >= totals.totalCents ? <p>{t('À rendre : {amount}', { amount: formatMoney(receivedCents - totals.totalCents) })}</p> : null}
          <div className="erp-register__actions">
            <Button disabled={locked} onClick={() => void record('cash', null)}>{busy ? t('Enregistrement…') : t('Encaisser en espèces')}</Button>
            {payrexxEnabled ? <Button variant="secondary" disabled={locked} onClick={() => void startPayrexx()}>{t('TWINT ou carte')}</Button> : null}
            <Button variant="secondary" disabled={locked} onClick={() => void record('terminal', null)}>{t('Terminal de carte')}</Button>
          </div>
          {!payrexxEnabled ? <p>{t('TWINT et carte par QR demandent un compte Payrexx, à activer dans Paramètres › Entreprise et facturation.')}</p> : null}
        </div> : null}
        {last ? <div className="pos__done" role="status">
          <p>{t('Ticket {number} enregistré · {amount}', { number: last.ticket.number, amount: formatMoney(last.ticket.totalCents) })}{last.ticket.changeCents ? ` · ${t('À rendre : {amount}', { amount: formatMoney(last.ticket.changeCents) })}` : ''}</p>
          {last.shortfalls.length ? <p>{t('Stock insuffisant pour {items} : vérifiez l’inventaire.', { items: last.shortfalls.join(', ') })}</p> : null}
          <div className="erp-register__actions">
            <Button variant="secondary" onClick={() => print(last.ticket, last.lines)}>{t('Imprimer le ticket')}</Button>
          </div>
        </div> : null}
      </div>
    </div> : null}
    <h3>{t('Ventes du jour')}</h3>
    {day && day.totals.ticketCount > 0 ? <p>{t('{n} tickets · {amount} · espèces {cash} · TWINT ou carte {payrexx} · terminal {terminal}', {
      n: day.totals.ticketCount, amount: formatMoney(day.totals.totalCents), cash: formatMoney(day.totals.cashCents), payrexx: formatMoney(day.totals.payrexxCents), terminal: formatMoney(day.totals.terminalCents),
    })}</p> : <p>{t('Aucune vente aujourd’hui.')}</p>}
    {kept.length || voided.size ? <ul className="erp-register__list" aria-label={t('Tickets du jour')}>
      {[...(day?.tickets ?? [])].filter((ticket) => ticket.kind === 'sale').reverse().map((ticket) => <li key={ticket.id}>
        <span><strong>{ticket.number}</strong><small>{t(METHOD_LABEL[ticket.method])}{voided.has(ticket.id) ? ` · ${t('Annulé')}` : ''}</small></span>
        <span className="erp-register__amount">
          <span className={voided.has(ticket.id) ? 'is-negative' : ''}>{formatMoney(ticket.totalCents)}</span>
          {!closed && !voided.has(ticket.id) ? <span className="pos__ticket-actions">
            <Button variant="ghost" size="small" disabled={locked} onClick={() => print(ticket, day?.lines.filter((line) => line.ticketId === ticket.id) ?? [])}>{t('Imprimer')}</Button>
            <Button variant="ghost" size="small" disabled={locked} onClick={() => void voidTicket(ticket)}>{t('Annuler')}</Button>
          </span> : null}
        </span>
      </li>)}
    </ul> : null}
    {!closed && day && day.totals.ticketCount > 0 ? <div className="erp-register__actions">
      <Button variant="secondary" disabled={locked} onClick={() => void closeDay()}>{busy ? t('Clôture…') : t('Clôturer la caisse du jour')}</Button>
    </div> : null}
  </section>;
}
