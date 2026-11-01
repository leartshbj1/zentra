import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Mail, Phone } from 'lucide-react';
import { diagnosticInvoke as invoke } from './diagnostics';
import { getAppLocale, t, useAppLanguage } from './language';
import type { Organization } from './types';
import { Button, Field } from './ui';
import { errorMessage } from './utils';
import { ZSwitch } from './ZSwitch';
import './storefront.css';

/** Page du commerce sur <adresse>.zentraapp.ch : l'adresse est unique, le
 * serveur la vérifie à chaque frappe et propose des adresses libres. Les
 * demandes envoyées depuis la page se lisent ici et arrivent en notification. */
export type StorefrontProfile = {
  companyName: string; tagline: string; description: string; services: string[]; street: string; postalCode: string; locality: string;
  phone: string; email: string; website: string; hours: string; quoteRequests: boolean; contactRequests: boolean;
};
export type StorefrontPage = { slug: string; url: string; published: boolean; profile: StorefrontProfile; updatedAt: number };
type SlugState = 'available' | 'yours' | 'taken' | 'too_short' | 'too_long' | 'invalid' | 'reserved';
type CheckReply = { slug: string; state: SlugState; url: string | null; suggestions: string[] };
export type StorefrontRequest = {
  requestId: string; kind: 'quote' | 'contact'; contactName: string; email: string; phone: string; locality: string; message: string; at: number;
};
type RequestsReply = { items: StorefrontRequest[]; nextCursor: string | null };

export const SITE_SUFFIX = '.zentraapp.ch';

export const storefrontApi = {
  read: () => invoke<{ organizationId: string; page: StorefrontPage | null }>('storefront_request', { input: { action: 'read' } }),
  check: (slug: string, locality: string, canton: string) =>
    invoke<CheckReply>('storefront_request', { input: { action: 'check', slug, locality, canton } }),
  save: (slug: string, published: boolean, profile: StorefrontProfile) =>
    invoke<{ organizationId: string; page: StorefrontPage }>('storefront_request', { input: { action: 'save', slug, published, profile } }),
  requests: (cursor: string | null, limit = 100) =>
    invoke<{ organizationId: string } & RequestsReply>('storefront_request', { input: { action: 'requests', cursor, limit } }),
};

/** Same folding as the server: what the visitor will type in the address bar. */
export function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l')
    .replace(/&/g, ' et ').replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}

const https = (value: string) => {
  const text = value.trim();
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text.replace(/^http:\/\//i, 'https://') : `https://${text}`;
};

/** A first page from the company's own settings: nothing is invented. */
export function profileFromOrganization(org: Organization): StorefrontProfile {
  return {
    companyName: org.legalName.trim(), tagline: '', description: '', services: [],
    street: [org.address.street, org.address.buildingNumber].filter(Boolean).join(' ').trim(),
    postalCode: org.address.postalCode.trim(), locality: org.address.city.trim(), phone: org.phone.trim(), email: org.email.trim(),
    website: https(org.website), hours: '', quoteRequests: true, contactRequests: true,
  };
}

const STATE_TEXT: Record<SlugState, string> = {
  available: 'Libre : cette adresse peut être la vôtre.',
  yours: 'C’est l’adresse actuelle de votre page.',
  taken: 'Déjà prise par une autre entreprise.',
  reserved: 'Réservée à Zentra. Choisissez-en une autre.',
  too_short: 'Trop courte : 3 caractères au moins.',
  too_long: 'Trop longue : 40 caractères au plus.',
  invalid: 'Lettres sans accents, chiffres et traits d’union seulement.',
};

const when = (seconds: number) => new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(seconds * 1000));
const seenKey = (organizationId: string) => `zentra.storefront.seen.v1.${organizationId}`;
export const STOREFRONT_ACTIVE_KEY = 'zentra.storefront.active.v1';

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="storefront-settings__link">
    <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https:\/\//, '').replace(/\/$/, '')}<ExternalLink size={14} aria-hidden="true" /></a>
    <Button type="button" variant="secondary" size="small" onClick={async () => {
      try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
    }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? t('Copié') : t('Copier le lien')}</Button>
  </div>;
}

export function StorefrontSettings({ organization, disabled }: { organization: Organization; disabled: boolean }) {
  useAppLanguage();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [page, setPage] = useState<StorefrontPage | null>(null);
  const [draft, setDraft] = useState<StorefrontProfile>(() => profileFromOrganization(organization));
  const [servicesText, setServicesText] = useState('');
  const [slugText, setSlugText] = useState(() => slugify(organization.legalName));
  const [published, setPublished] = useState(true);
  const [check, setCheck] = useState<CheckReply | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [requests, setRequests] = useState<StorefrontRequest[]>([]);
  const [seen, setSeen] = useState('');
  const checkRun = useRef(0);
  const locked = disabled || saving;

  async function loadRequests(org: string) {
    const items: StorefrontRequest[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index++) {
      const reply = await storefrontApi.requests(cursor);
      items.push(...reply.items);
      if (!reply.nextCursor || reply.nextCursor === cursor || reply.items.length < 100) break;
      cursor = reply.nextCursor;
    }
    setRequests(items.reverse());
    let previous = '';
    try { previous = localStorage.getItem(seenKey(org)) ?? ''; } catch { previous = ''; }
    setSeen(previous);
    if (items.length) try { localStorage.setItem(seenKey(org), items[0].requestId); } catch { /* relu la prochaine fois */ }
  }

  async function load() {
    try {
      const reply = await storefrontApi.read();
      setOrganizationId(reply.organizationId);
      setPage(reply.page);
      if (reply.page) {
        setDraft(reply.page.profile);
        setServicesText(reply.page.profile.services.join('\n'));
        setSlugText(reply.page.slug);
        setPublished(reply.page.published);
        try { localStorage.setItem(STOREFRONT_ACTIVE_KEY, '1'); } catch { /* sans effet sur la page */ }
        await loadRequests(reply.organizationId).catch(() => undefined);
      }
      setLoadError('');
      setLoaded(true);
    } catch (reason) {
      setLoadError(errorMessage(reason, t('La page n’a pas pu être lue. Vérifiez que votre compte Zentra est connecté.')));
    }
  }
  useEffect(() => { void load(); }, []);

  // The server answers for every keystroke pause: free, yours, taken, reserved…
  useEffect(() => {
    if (!loaded || disabled) return;
    const wanted = slugText.trim();
    if (!wanted) { setCheck(null); return; }
    const run = ++checkRun.current;
    setChecking(true);
    const timer = window.setTimeout(() => {
      storefrontApi.check(wanted, draft.locality, organization.address.canton)
        .then(reply => { if (run === checkRun.current) setCheck(reply); })
        .catch(() => { if (run === checkRun.current) setCheck(null); })
        .finally(() => { if (run === checkRun.current) setChecking(false); });
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugText, loaded, disabled]);

  const slug = check?.slug ?? slugify(slugText);
  const usable = check !== null && check.slug === slugify(slugText) && (check.state === 'available' || check.state === 'yours');
  const services = servicesText.split('\n').map(line => line.trim()).filter(Boolean);
  const canSave = usable && !checking && draft.companyName.trim().length > 0 && services.length <= 12 && !locked;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setMessage(null);
    try {
      const profile = { ...draft, website: https(draft.website), services: [...new Set(services)] };
      const reply = await storefrontApi.save(slug, published, profile);
      setPage(reply.page);
      setDraft(reply.page.profile);
      setSlugText(reply.page.slug);
      try { localStorage.setItem(STOREFRONT_ACTIVE_KEY, '1'); } catch { /* sans effet sur la page */ }
      setMessage({ tone: 'ok', text: reply.page.published ? t('Page publiée.') : t('Page enregistrée, sans être publiée.') });
    } catch (reason) {
      setMessage({ tone: 'error', text: errorMessage(reason, t('La page n’a pas pu être enregistrée.')) });
      // Taken meanwhile: ask again, so the free alternatives show up.
      checkRun.current++;
      storefrontApi.check(slug, draft.locality, organization.address.canton).then(setCheck).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <div className="storefront-settings">
    <p className="settings-copy">{loadError || t('Lecture de votre page…')}</p>
    {loadError ? <div className="form-actions"><Button variant="secondary" onClick={() => void load()}>{t('Réessayer')}</Button></div> : null}
  </div>;

  const set = <K extends keyof StorefrontProfile>(key: K, value: StorefrontProfile[K]) => setDraft(current => ({ ...current, [key]: value }));
  // Newest first: everything above the last request already shown is new.
  const seenIndex = requests.findIndex(row => row.requestId === seen);
  const tone = check ? (check.state === 'available' || check.state === 'yours' ? 'ok' : 'error') : 'idle';

  return <div className="storefront-settings">
    <section className="reminder-charges" aria-labelledby="storefront-address-title">
      <h3 id="storefront-address-title">{t('Adresse de votre page')}</h3>
      <p>{t('Vos clients trouvent votre entreprise, vous appellent ou demandent un devis. Chaque demande arrive dans Zentra.')}</p>
      {page?.published ? <CopyLink url={page.url} /> : null}
      <div className="storefront-settings__address">
        <label htmlFor="storefront-slug">{t('Adresse')}</label>
        <div className={`storefront-settings__slug storefront-settings__slug--${tone}`}>
          <span aria-hidden="true">https://</span>
          <input id="storefront-slug" value={slugText} maxLength={60} disabled={locked} autoComplete="off" autoCapitalize="none" spellCheck={false}
            aria-describedby="storefront-slug-state" onChange={event => setSlugText(event.target.value.toLowerCase())} />
          <span aria-hidden="true">{SITE_SUFFIX}</span>
        </div>
        <p id="storefront-slug-state" className={`storefront-settings__state storefront-settings__state--${tone}`} role="status" aria-live="polite">
          {checking ? t('Vérification…') : check ? <>
            {check.slug !== slugText.trim() && check.slug ? <span>{t('Votre adresse sera : {address}', { address: `${check.slug}${SITE_SUFFIX}` })} </span> : null}
            {t(STATE_TEXT[check.state])}
          </> : null}
        </p>
        {check && check.suggestions.length && !usable ? <div className="storefront-settings__suggestions">
          <span>{t('Adresses libres :')}</span>
          {check.suggestions.map(value => <button key={value} type="button" disabled={locked} onClick={() => setSlugText(value)}>{value}{SITE_SUFFIX}</button>)}
        </div> : null}
      </div>
    </section>

    <section className="reminder-charges" aria-labelledby="storefront-profile-title">
      <h3 id="storefront-profile-title">{t('Ce que la page montre')}</h3>
      <p>{t('Repris de vos réglages d’entreprise. Modifiez ce que vous voulez : la page ne montre que ce qui est rempli.')}</p>
      <div className="storefront-settings__grid">
        <Field label={t('Nom affiché')} required><input value={draft.companyName} maxLength={120} disabled={locked} onChange={event => set('companyName', event.target.value)} /></Field>
        <Field label={t('Phrase d’accroche')} hint={t('Par exemple : Sanitaire et chauffage à Genève depuis 1998')}>
          <input value={draft.tagline} maxLength={160} disabled={locked} onChange={event => set('tagline', event.target.value)} />
        </Field>
        <Field label={t('Présentation')} wide><textarea value={draft.description} maxLength={1500} rows={4} disabled={locked} onChange={event => set('description', event.target.value)} /></Field>
        <Field label={t('Prestations')} hint={t('Une par ligne, 12 au plus.')} error={services.length > 12 ? t('12 prestations au plus.') : undefined} wide>
          <textarea value={servicesText} rows={4} disabled={locked} onChange={event => setServicesText(event.target.value)} />
        </Field>
        <Field label={t('Rue et numéro')}><input value={draft.street} maxLength={160} disabled={locked} onChange={event => set('street', event.target.value)} /></Field>
        <Field label={t('NPA')}><input value={draft.postalCode} maxLength={12} inputMode="numeric" disabled={locked} onChange={event => set('postalCode', event.target.value)} /></Field>
        <Field label={t('Localité')}><input value={draft.locality} maxLength={80} disabled={locked} onChange={event => set('locality', event.target.value)} /></Field>
        <Field label={t('Téléphone')}><input type="tel" value={draft.phone} maxLength={40} disabled={locked} onChange={event => set('phone', event.target.value)} /></Field>
        <Field label={t('E-mail')}><input type="email" value={draft.email} maxLength={254} disabled={locked} onChange={event => set('email', event.target.value)} /></Field>
        <Field label={t('Site web')}><input type="url" inputMode="url" value={draft.website} maxLength={200} placeholder="https://" disabled={locked} onChange={event => set('website', event.target.value)} /></Field>
        <Field label={t('Horaires')} wide><textarea value={draft.hours} maxLength={600} rows={2} disabled={locked} onChange={event => set('hours', event.target.value)} /></Field>
      </div>
      <label className="reminder-charges__interest">
        <ZSwitch checked={draft.quoteRequests} disabled={locked} onChange={(checked: boolean) => set('quoteRequests', checked)} />
        <span><strong>{t('Recevoir des demandes de devis')}</strong><small>{t('Un formulaire « Demander un devis » sur la page.')}</small></span>
      </label>
      <label className="reminder-charges__interest">
        <ZSwitch checked={draft.contactRequests} disabled={locked} onChange={(checked: boolean) => set('contactRequests', checked)} />
        <span><strong>{t('Recevoir d’autres questions')}</strong><small>{t('Vos clients peuvent aussi vous écrire pour autre chose.')}</small></span>
      </label>
      <label className="reminder-charges__interest">
        <ZSwitch checked={published} disabled={locked} onChange={(checked: boolean) => setPublished(checked)} />
        <span><strong>{t('Page visible sur internet')}</strong><small>{t('Désactivé : l’adresse reste à vous, mais la page n’est plus affichée.')}</small></span>
      </label>
    </section>

    <div className="reminder-charges__actions">
      <Button type="button" disabled={!canSave} onClick={() => void save()}>{saving ? t('Enregistrement…') : page ? t('Enregistrer la page') : t('Créer ma page')}</Button>
      {page ? <a className="storefront-settings__preview" href={page.url} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden="true" />{t('Voir la page')}</a> : null}
      {message ? <p role="status" className={message.tone === 'error' ? 'storefront-settings__error' : undefined}>{message.text}</p> : null}
    </div>

    {page ? <section className="reminder-charges" aria-labelledby="storefront-requests-title">
      <div className="storefront-settings__requests-head">
        <h3 id="storefront-requests-title">{t('Demandes reçues')}</h3>
        <Button type="button" variant="ghost" size="small" onClick={() => void loadRequests(organizationId).catch(() => undefined)}>{t('Actualiser')}</Button>
      </div>
      {requests.length ? <ul className="storefront-settings__requests">
        {requests.map((item, index) => {
          const fresh = seenIndex === -1 || index < seenIndex;
          return <li key={item.requestId}>
            <div className="storefront-settings__request-head">
              <strong>{item.contactName}</strong>
              <span className={`storefront-settings__kind storefront-settings__kind--${item.kind}`}>{item.kind === 'quote' ? t('Devis') : t('Question')}</span>
              {fresh ? <span className="storefront-settings__new">{t('Nouveau')}</span> : null}
              <small>{when(item.at)}{item.locality ? ` · ${item.locality}` : ''}</small>
            </div>
            <p>{item.message}</p>
            <div className="storefront-settings__request-actions">
              {item.email ? <a href={`mailto:${item.email}?subject=${encodeURIComponent(item.kind === 'quote' ? t('Votre demande de devis') : t('Votre question'))}`}><Mail size={15} aria-hidden="true" />{item.email}</a> : null}
              {item.phone ? <a href={`tel:${item.phone.replace(/[^0-9+]/g, '')}`}><Phone size={15} aria-hidden="true" />{item.phone}</a> : null}
            </div>
          </li>;
        })}
      </ul> : <p>{t('Aucune demande pour le moment. Partagez le lien de votre page : sur votre fiche Google, vos réseaux, vos e-mails ou un QR code.')}</p>}
    </section> : null}
  </div>;
}
