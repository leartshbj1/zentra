import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import type { OnlinePaymentSettings as Settings } from './types';
import { Button, Field } from './ui';
import { errorMessage } from './utils';
import './reminder-charges.css';

/** Paiement en ligne (TWINT, cartes) par le compte Payrexx de l'entreprise. Désactivé par défaut. */
export function OnlinePaymentSettings({ disabled }: { disabled: boolean }) {
  useAppLanguage();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [instance, setInstance] = useState('');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    desktopApi.getOnlinePaymentSettings().then((value) => {
      if (!live) return;
      setSettings(value);
      setInstance(value.instance);
      setEnabled(value.enabled);
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const locked = disabled || saving || !settings;

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      const next = await desktopApi.saveOnlinePaymentSettings({ enabled, instance: instance.trim(), ...(secret.trim() ? { apiSecret: secret.trim() } : {}) });
      setSettings(next);
      setSecret('');
      setMessage(next.enabled
        ? t('Paiement en ligne activé. Le bouton « Lien de paiement » apparaît sur les factures ouvertes.')
        : t('Paiement en ligne désactivé. Aucun lien ne sera créé.'));
    } catch (reason) {
      setEnabled(settings?.enabled ?? false);
      setMessage(errorMessage(reason, t('Le réglage n’a pas pu être enregistré.')));
    } finally {
      setSaving(false);
    }
  }

  return <section className="reminder-charges" aria-labelledby="online-payment-title">
    <h3 id="online-payment-title">{t('Paiement en ligne par TWINT et carte')}</h3>
    <p>{t('Envoyez à votre client un lien pour payer une facture par TWINT, Visa ou Mastercard. Il faut un compte marchand Payrexx à votre nom : l’argent arrive directement chez vous, Zentra ne le touche jamais.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Ouvrez un compte sur payrexx.com et activez TWINT et les cartes.')}</li>
        <li>{t('Dans Payrexx, ouvrez Intégrations › API et copiez la clé API. Le nom d’instance est le début de votre adresse Payrexx.')}</li>
        <li>{t('Collez-les ici, puis activez. Zentra vérifie l’accès auprès de Payrexx.')}</li>
        <li>{t('Quand le client a payé, Autopilote vous propose d’enregistrer le paiement en un clic.')}</li>
      </ol>
    </details>
    <div className="reminder-charges__fees">
      <Field label={t('Instance Payrexx')} hint={t('Par exemple atelier pour atelier.payrexx.com')}>
        <input autoComplete="off" spellCheck={false} value={instance} disabled={locked} onChange={(event) => setInstance(event.target.value)} />
      </Field>
      <Field label={t('Clé API')} hint={settings?.secretPresent ? t('Enregistrée sur cet appareil. Laissez vide pour la garder.') : t('Gardée chiffrée sur cet appareil, jamais envoyée à Zentra.')}>
        <input type="password" autoComplete="off" value={secret} disabled={locked} onChange={(event) => setSecret(event.target.value)} />
      </Field>
    </div>
    <label className="reminder-charges__interest">
      <input type="checkbox" role="switch" aria-checked={enabled} checked={enabled} disabled={locked} onChange={(event) => setEnabled(event.target.checked)} />
      <span><strong>{t('Proposer le paiement par TWINT et carte')}</strong><small>{t('Désactivé tant que vous ne l’activez pas.')}</small></span>
    </label>
    <div className="reminder-charges__actions">
      <Button type="button" variant="secondary" disabled={locked} onClick={() => void save()}>{saving ? t('Vérification…') : t('Enregistrer')}</Button>
      {message && <p role="status">{message}</p>}
    </div>
  </section>;
}
