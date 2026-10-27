import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { diagnosticInvoke as invoke } from './diagnostics';
import { openIntegrationsSettings } from './automation';
import { getAppLocale, t, useAppLanguage } from './language';
import { Button, Field } from './ui';
import { errorMessage } from './utils';

/** API, MCP, webhooks, boutiques et courrier Pingen : les mêmes réglages que sur
 * le compte Zentra, faits ici. Titulaire et administrateurs ; les jetons et
 * secrets ne sont montrés qu'une fois, à leur création. */
type Key = { keyId: string; name: string; prefix: string; scopes: string; lastUsedAt: string | null };
type Webhook = { endpointId: string; url: string; paused: boolean; lastSuccessAt: string | null };
type Shop = { connectionId: string; platform: 'shopify' | 'woocommerce'; shopDomain: string; receiverUrl: string; lastEventAt: string | null };
type Postal = { mode: 'staging' | 'production'; pingenOrganisationId: string; clientId: string; addressPosition: 'left' | 'right'; updatedAt: string } | null;
export type IntegrationsOverview = {
  apiBaseUrl: string; mcpUrl: string; projection: { publishedAt: string | null } | null; pendingDrafts: number;
  keys: Key[]; webhooks: Webhook[]; shops: Shop[]; postal: Postal;
};

const EVENTS = [
  ['invoice.created', 'Facture émise'], ['invoice.paid', 'Facture payée'], ['quote.created', 'Devis émis'], ['quote.accepted', 'Devis accepté'],
  ['order.created', 'Commande confirmée'], ['payment.created', 'Paiement enregistré'], ['customer.created', 'Nouveau client'],
  ['draft.imported', 'Brouillon validé'], ['draft.rejected', 'Brouillon refusé'],
] as const;

export const integrationsApi = {
  overview: () => invoke<IntegrationsOverview>('integrations_overview'),
  action: (input: Record<string, unknown>) => invoke<Record<string, unknown>>('integrations_action', { input }),
};

const when = (value: string | null) => value ? new Intl.DateTimeFormat(getAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="integration-copy">
    <code aria-label={label}>{value}</code>
    <Button type="button" variant="secondary" size="small" onClick={async () => {
      try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
    }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? t('Copié') : t('Copier')}</Button>
  </div>;
}

export function IntegrationsSettings({ disabled }: { disabled: boolean }) {
  useAppLanguage();
  const [data, setData] = useState<IntegrationsOverview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<'read' | 'read drafts'>('read');
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>(EVENTS.map(([id]) => id));
  const [platform, setPlatform] = useState<'shopify' | 'woocommerce'>('shopify');
  const [shopDomain, setShopDomain] = useState('');
  const [shopSecret, setShopSecret] = useState('');
  const [postal, setPostal] = useState({ mode: 'staging' as 'staging' | 'production', pingenOrganisationId: '', clientId: '', clientSecret: '', addressPosition: 'right' as 'left' | 'right' });
  const locked = disabled || busy;

  const load = async () => {
    try {
      const next = await integrationsApi.overview();
      setData(next); setLoadError('');
      if (next.postal) setPostal(current => ({ ...current, mode: next.postal!.mode, pingenOrganisationId: next.postal!.pingenOrganisationId, clientId: next.postal!.clientId, addressPosition: next.postal!.addressPosition }));
    } catch (reason) {
      setLoadError(errorMessage(reason, t('Les connexions n’ont pas pu être lues.')));
    }
  };
  useEffect(() => { void load(); }, []);

  async function act(body: Record<string, unknown>, after?: (result: Record<string, unknown>) => void) {
    if (locked) return;
    setBusy(true); setError('');
    try {
      const result = await integrationsApi.action(body);
      after?.(result);
      await load();
    } catch (reason) {
      setError(errorMessage(reason, t('L’opération n’a pas abouti.')));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="integrations-settings">
    <p className="settings-copy">{loadError || t('Lecture des connexions…')}</p>
    {loadError ? <div className="form-actions">
      <Button variant="secondary" onClick={() => void load()}>{t('Réessayer')}</Button>
      <Button variant="ghost" onClick={() => void openIntegrationsSettings().catch(() => undefined)}><ExternalLink size={16} /> {t('Ouvrir sur zentraapp.ch')}</Button>
    </div> : null}
  </div>;

  return <div className="integrations-settings">
    {error ? <p className="integrations-settings__error" role="alert">{error}</p> : null}
    {secret ? <section className="integrations-settings__secret" aria-live="polite">
      <h3>{secret.title}</h3>
      <p>{t('Copiez-le maintenant : il ne sera plus affiché. Gardez-le comme un mot de passe.')}</p>
      <CopyField value={secret.value} label={t('Secret à copier')} />
      <div className="form-actions"><Button variant="secondary" onClick={() => setSecret(null)}>{t('C’est noté')}</Button></div>
    </section> : null}

    <section aria-labelledby="integrations-api">
      <h3 id="integrations-api">{t('API et MCP')}</h3>
      <p className="settings-copy">{t('Vos outils lisent clients, articles, devis, commandes, factures et paiements. Ce qu’ils envoient arrive en brouillon dans Zentra : rien n’est enregistré sans votre validation.')}</p>
      <dl className="integrations-settings__facts">
        <div><dt>{t('Adresse de l’API')}</dt><dd><CopyField value={data.apiBaseUrl} label={t('Adresse de l’API')} /></dd></div>
        <div><dt>{t('Serveur MCP')}</dt><dd><CopyField value={data.mcpUrl} label={t('Serveur MCP')} /></dd></div>
        <div><dt>{t('Données publiées par l’app')}</dt><dd>{data.projection?.publishedAt ? when(data.projection.publishedAt) : t('Pas encore : elles partent dès qu’une clé existe.')}</dd></div>
        <div><dt>{t('Brouillons en attente')}</dt><dd>{data.pendingDrafts}</dd></div>
      </dl>
      <p className="integrations-settings__links">
        <a href="https://zentraapp.ch/compte/integrations#assistants" target="_blank" rel="noreferrer">{t('Connecter Claude, ChatGPT ou Le Chat')}</a>
        <a href="https://zentraapp.ch/compte/integrations#agenda" target="_blank" rel="noreferrer">{t('Agenda dans Google, Outlook ou Apple')}</a>
        <a href="https://zentraapp.ch/tutoriels#zapier" target="_blank" rel="noreferrer">{t('Zapier, Make et n8n')}</a>
      </p>
      {data.keys.length ? <ul className="integrations-settings__list">
        {data.keys.map(key => <li key={key.keyId}>
          <span><strong>{key.name}</strong><small><code>{key.prefix}…</code> · {key.scopes === 'read drafts' ? t('Lecture et brouillons') : t('Lecture')} · {t('Dernier usage')} {when(key.lastUsedAt)}</small></span>
          <Button variant="secondary" size="small" disabled={locked} onClick={() => void act({ action: 'revoke-key', keyId: key.keyId })}>{t('Révoquer')}</Button>
        </li>)}
      </ul> : <p className="settings-copy">{t('Aucune clé pour le moment.')}</p>}
      <form className="integrations-settings__form" onSubmit={event => { event.preventDefault(); void act({ action: 'create-key', name: keyName, scopes: keyScopes }, result => { setKeyName(''); setSecret({ title: t('Votre nouvelle clé'), value: String(result.token) }); }); }}>
        <Field label={t('Nom de la clé')}><input value={keyName} maxLength={80} required disabled={locked} placeholder={t('Par exemple : site internet')} onChange={event => setKeyName(event.target.value)} /></Field>
        <Field label={t('Accès')}><select value={keyScopes} disabled={locked} onChange={event => setKeyScopes(event.target.value as 'read' | 'read drafts')}>
          <option value="read">{t('Lecture')}</option><option value="read drafts">{t('Lecture et brouillons')}</option>
        </select></Field>
        <div className="form-actions"><Button type="submit" disabled={locked}>{t('Créer la clé')}</Button></div>
      </form>
    </section>

    <section aria-labelledby="integrations-webhooks">
      <h3 id="integrations-webhooks">{t('Webhooks')}</h3>
      <p className="settings-copy">{t('Zentra prévient votre adresse à chaque événement choisi. Chaque envoi est signé et renvoyé jusqu’à huit fois en cas d’échec.')}</p>
      {data.webhooks.length ? <ul className="integrations-settings__list">
        {data.webhooks.map(hook => <li key={hook.endpointId}>
          <span><strong>{hook.url}</strong><small>{hook.paused ? t('En pause après des échecs répétés') : t('Actif')} · {t('Dernier envoi réussi')} {when(hook.lastSuccessAt)}</small></span>
          <span className="integrations-settings__buttons">
            {hook.paused
              ? <Button variant="secondary" size="small" disabled={locked} onClick={() => void act({ action: 'resume-webhook', endpointId: hook.endpointId })}>{t('Reprendre')}</Button>
              : <Button variant="secondary" size="small" disabled={locked} onClick={() => void act({ action: 'test-webhook', endpointId: hook.endpointId })}>{t('Envoyer un test')}</Button>}
            <Button variant="secondary" size="small" disabled={locked} onClick={() => void act({ action: 'delete-webhook', endpointId: hook.endpointId })}>{t('Supprimer')}</Button>
          </span>
        </li>)}
      </ul> : null}
      <form className="integrations-settings__form" onSubmit={event => { event.preventDefault(); void act({ action: 'create-webhook', url: hookUrl, events: hookEvents.length === EVENTS.length ? '*' : hookEvents }, result => { setHookUrl(''); setSecret({ title: t('Secret de signature du webhook'), value: String(result.secret) }); }); }}>
        <Field label={t('Adresse https')}><input type="url" value={hookUrl} required disabled={locked} placeholder="https://exemple.ch/zentra" onChange={event => setHookUrl(event.target.value)} /></Field>
        <fieldset className="integrations-settings__events" disabled={locked}>
          <legend>{t('Événements')}</legend>
          {EVENTS.map(([id, label]) => <label key={id}><input type="checkbox" checked={hookEvents.includes(id)} onChange={event => setHookEvents(event.target.checked ? [...hookEvents, id] : hookEvents.filter(item => item !== id))} /><span>{t(label)}</span></label>)}
        </fieldset>
        <div className="form-actions"><Button type="submit" disabled={locked || !hookEvents.length}>{t('Ajouter le webhook')}</Button></div>
      </form>
    </section>

    <section aria-labelledby="integrations-shops">
      <h3 id="integrations-shops">{t('Boutiques en ligne')}</h3>
      <p className="settings-copy">{t('Chaque commande Shopify ou WooCommerce arrive dans Zentra Autopilote comme une commande client à valider. Chaque paiement de la boutique se rapproche de sa facture.')}</p>
      {data.shops.length ? <ul className="integrations-settings__list">
        {data.shops.map(shop => <li key={shop.connectionId}>
          <span><strong>{shop.platform === 'shopify' ? 'Shopify' : 'WooCommerce'} · {shop.shopDomain}</strong><small>{t('Dernière commande reçue')} {when(shop.lastEventAt)}</small>
            <CopyField value={shop.receiverUrl} label={t('Adresse de réception')} /></span>
          <Button variant="secondary" size="small" disabled={locked} onClick={() => void act({ action: 'delete-shop', connectionId: shop.connectionId })}>{t('Retirer')}</Button>
        </li>)}
      </ul> : null}
      <form className="integrations-settings__form" onSubmit={event => { event.preventDefault(); void act({ action: 'create-shop', platform, shopDomain, secret: shopSecret }, () => { setShopDomain(''); setShopSecret(''); }); }}>
        <Field label={t('Plateforme')}><select value={platform} disabled={locked} onChange={event => setPlatform(event.target.value as 'shopify' | 'woocommerce')}>
          <option value="shopify">Shopify</option><option value="woocommerce">WooCommerce</option>
        </select></Field>
        <Field label={t('Adresse de la boutique')}><input value={shopDomain} required disabled={locked} placeholder={platform === 'shopify' ? 'ma-boutique.myshopify.com' : 'boutique.ch'} onChange={event => setShopDomain(event.target.value)} /></Field>
        <Field label={t('Secret de signature')}><input type="password" value={shopSecret} required disabled={locked} autoComplete="off" onChange={event => setShopSecret(event.target.value)} /></Field>
        <p className="settings-copy">{platform === 'shopify'
          ? t('Dans Shopify : Paramètres › Notifications › Webhooks. Créez « Création de commande », « Paiement de commande » et « Annulation de commande » en JSON, puis collez ici la clé de signature affichée sous la liste.')
          : t('Dans WooCommerce : Réglages › Avancé › Webhooks. Créez « Commande créée » et « Commande mise à jour » avec un secret de votre choix, collez-le ici, puis l’adresse de réception là-bas.')}</p>
        <div className="form-actions"><Button type="submit" disabled={locked}>{t('Relier la boutique')}</Button></div>
      </form>
    </section>

    <section aria-labelledby="integrations-postal">
      <h3 id="integrations-postal">{t('Factures par la poste')}</h3>
      <p className="settings-copy">{t('Zentra imprime et poste vos factures par Pingen, avec votre propre compte Pingen : chaque lettre vous est facturée directement par Pingen. Ensuite, « Envoyer par la poste » apparaît dans le menu « … » de chaque facture émise.')}</p>
      {data.postal ? <p className="settings-copy"><strong>{data.postal.mode === 'production' ? t('Envois réels') : t('Mode d’essai : aucune lettre n’est postée')}</strong> · {t('Enregistré le')} {when(data.postal.updatedAt)}</p> : null}
      <form className="integrations-settings__form" onSubmit={event => { event.preventDefault(); void act({ action: 'save-postal', ...postal }, () => setPostal(current => ({ ...current, clientSecret: '' }))); }}>
        <Field label={t('Mode')}><select value={postal.mode} disabled={locked} onChange={event => setPostal({ ...postal, mode: event.target.value as 'staging' | 'production' })}>
          <option value="staging">{t('Essai (Pingen staging)')}</option><option value="production">{t('Envois réels')}</option>
        </select></Field>
        <Field label={t('Identifiant d’organisation Pingen')}><input value={postal.pingenOrganisationId} required disabled={locked} placeholder="00000000-0000-0000-0000-000000000000" onChange={event => setPostal({ ...postal, pingenOrganisationId: event.target.value })} /></Field>
        <Field label={t('Identifiant client (client ID)')}><input value={postal.clientId} required disabled={locked} autoComplete="off" onChange={event => setPostal({ ...postal, clientId: event.target.value })} /></Field>
        <Field label={t('Secret client')}><input type="password" value={postal.clientSecret} required disabled={locked} autoComplete="off" onChange={event => setPostal({ ...postal, clientSecret: event.target.value })} /></Field>
        <Field label={t('Adresse du destinataire sur la facture')}><select value={postal.addressPosition} disabled={locked} onChange={event => setPostal({ ...postal, addressPosition: event.target.value as 'left' | 'right' })}>
          <option value="right">{t('À droite (enveloppe suisse)')}</option><option value="left">{t('À gauche')}</option>
        </select></Field>
        <div className="form-actions">
          <Button type="submit" disabled={locked}>{t('Vérifier et enregistrer')}</Button>
          {data.postal ? <Button type="button" variant="secondary" disabled={locked} onClick={() => void act({ action: 'delete-postal' })}>{t('Désactiver')}</Button> : null}
        </div>
      </form>
    </section>
  </div>;
}
