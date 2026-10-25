import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { DEFAULT_ENGAGEMENT, type CustomerEngagementSettings, type SmsSettings } from './customerEngagement';
import { t, useAppLanguage } from './language';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage } from './utils';
import './reminder-charges.css';

const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'] as const;

/** Avis Google, prise de rendez-vous en ligne et acompte : une seule section, enregistrée d'un clic. */
export function CustomerSettings({ workspace, disabled, onWorkspace }: { workspace: Workspace; disabled: boolean; onWorkspace: (next: Workspace) => void }) {
  useAppLanguage();
  const [draft, setDraft] = useState<CustomerEngagementSettings>(workspace.customerEngagement ?? DEFAULT_ENGAGEMENT);
  const [percentText, setPercentText] = useState(String((workspace.customerEngagement?.depositPercentBp ?? 0) / 100));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = disabled || saving;

  async function save() {
    const percent = Number(percentText.replace(',', '.'));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) { setMessage(t('L’acompte va de 0 à 100 % du devis.')); return; }
    setSaving(true);
    setMessage('');
    try {
      const next = await desktopApi.saveCustomerEngagementSettings({ ...draft, reviewUrl: draft.reviewUrl?.trim() || null, depositPercentBp: Math.round(percent * 100) });
      onWorkspace(next);
      setMessage(t('Réglages enregistrés.'));
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le réglage n’a pas pu être enregistré.')));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <section className="reminder-charges" aria-labelledby="review-settings-title">
      <h3 id="review-settings-title">{t('Avis Google')}</h3>
      <p>{t('Après une facture payée, Autopilote propose de demander un avis au client, au plus une fois par période. Vous validez chaque demande d’un clic.')}</p>
      <div className="reminder-charges__fees">
        <Field label={t('Lien de votre fiche d’avis')} hint={t('Dans votre fiche Google Business, « Demander des avis » donne ce lien.')}>
          <input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://g.page/r/…" value={draft.reviewUrl ?? ''} disabled={locked}
            onChange={event => setDraft({ ...draft, reviewUrl: event.target.value })} />
        </Field>
        <Field label={t('Pas plus d’une demande par client tous les (jours)')}>
          <input inputMode="numeric" value={draft.reviewCooldownDays} disabled={locked} onChange={event => setDraft({ ...draft, reviewCooldownDays: Number(event.target.value.replace(/\D/g, '')) || 0 })} />
        </Field>
      </div>
      <label className="reminder-charges__interest">
        <input type="checkbox" role="switch" aria-checked={draft.reviewAuto} checked={draft.reviewAuto} disabled={locked} onChange={event => setDraft({ ...draft, reviewAuto: event.target.checked })} />
        <span><strong>{t('Demander l’avis par SMS sans attendre mon clic')}</strong><small>{t('Règle explicite : seulement si les SMS sont configurés. Chaque envoi reste dans le journal Autopilote.')}</small></span>
      </label>
    </section>
    <section className="reminder-charges" aria-labelledby="booking-settings-title">
      <h3 id="booking-settings-title">{t('Rendez-vous en ligne')}</h3>
      <p>{t('Sur la page client, vos clients choisissent un créneau libre de votre agenda, sans voir son contenu. Chaque demande arrive dans Autopilote pour que vous la validiez.')}</p>
      <label className="reminder-charges__interest">
        <input type="checkbox" role="switch" aria-checked={draft.bookingEnabled} checked={draft.bookingEnabled} disabled={locked} onChange={event => setDraft({ ...draft, bookingEnabled: event.target.checked })} />
        <span><strong>{t('Proposer la prise de rendez-vous en ligne')}</strong><small>{t('Désactivé tant que vous ne l’activez pas.')}</small></span>
      </label>
      {draft.bookingEnabled ? <>
        <fieldset className="terrain-days" disabled={locked}>
          <legend>{t('Jours proposés')}</legend>
          {DAYS.map((label, index) => <label key={label}><input type="checkbox" checked={(draft.bookingDays & (1 << index)) !== 0}
            onChange={event => setDraft({ ...draft, bookingDays: event.target.checked ? draft.bookingDays | (1 << index) : draft.bookingDays & ~(1 << index) })} /><span>{t(label)}</span></label>)}
        </fieldset>
        <div className="reminder-charges__fees">
          <Field label={t('De')}><input type="time" value={draft.bookingStart} disabled={locked} onChange={event => setDraft({ ...draft, bookingStart: event.target.value })} /></Field>
          <Field label={t('À')}><input type="time" value={draft.bookingEnd} disabled={locked} onChange={event => setDraft({ ...draft, bookingEnd: event.target.value })} /></Field>
          <Field label={t('Durée d’un rendez-vous')}>
            <select value={draft.bookingMinutes} disabled={locked} onChange={event => setDraft({ ...draft, bookingMinutes: Number(event.target.value) })}>
              {[30, 45, 60, 90, 120].map(value => <option key={value} value={value}>{t('{n} minutes', { n: value })}</option>)}
            </select>
          </Field>
          <Field label={t('Semaines proposées')}>
            <select value={draft.bookingWeeks} disabled={locked} onChange={event => setDraft({ ...draft, bookingWeeks: Number(event.target.value) })}>
              {[1, 2, 3, 4, 6, 8].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </Field>
        </div>
      </> : null}
    </section>
    <section className="reminder-charges" aria-labelledby="deposit-settings-title">
      <h3 id="deposit-settings-title">{t('Acompte à l’acceptation du devis')}</h3>
      <p>{t('Avec le paiement en ligne Payrexx activé, la page du devis propose de payer l’acompte dès que le client accepte. Zentra calcule le montant et le rapproche quand il est payé.')}</p>
      <div className="reminder-charges__fees">
        <Field label={t('Acompte (% du total TTC)')} hint={t('0 : pas d’acompte en ligne.')}>
          <input inputMode="decimal" value={percentText} disabled={locked} onChange={event => setPercentText(event.target.value)} />
        </Field>
      </div>
    </section>
    <div className="reminder-charges__actions">
      <Button type="button" variant="secondary" disabled={locked} onClick={() => void save()}>{saving ? t('Enregistrement…') : t('Enregistrer')}</Button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  </>;
}

/** Compte SMS de l'entreprise : éteint par défaut, facturé par le fournisseur. */
export function SmsSettingsPanel({ disabled }: { disabled: boolean }) {
  useAppLanguage();
  const [settings, setSettings] = useState<SmsSettings | null>(null);
  const [draft, setDraft] = useState<Omit<SmsSettings, 'secretPresent'>>({ enabled: false, provider: 'aspsms', sender: '', account: '', endpoint: null, appointmentRemindersAuto: false });
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    desktopApi.getSmsSettings().then(value => {
      if (!live) return;
      setSettings(value);
      const { secretPresent: _present, ...rest } = value;
      setDraft(rest);
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const locked = disabled || saving || !settings;

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      const next = await desktopApi.saveSmsSettings({ ...draft, ...(secret.trim() ? { secret: secret.trim() } : {}) });
      setSettings(next);
      setSecret('');
      setMessage(next.enabled ? t('SMS activés. Chaque envoi est facturé par votre fournisseur et noté dans le journal.') : t('SMS désactivés. Aucun SMS ne sera envoyé.'));
    } catch (reason) {
      setDraft(current => ({ ...current, enabled: settings?.enabled ?? false }));
      setMessage(errorMessage(reason, t('Le réglage n’a pas pu être enregistré.')));
    } finally {
      setSaving(false);
    }
  }

  return <section className="reminder-charges" aria-labelledby="sms-settings-title">
    <h3 id="sms-settings-title">{t('Rappels et relances par SMS')}</h3>
    <p>{t('Avec votre propre compte SMS, Autopilote prépare les rappels de rendez-vous la veille et les relances. Chaque SMS est payé à l’usage à votre fournisseur ; Zentra ne prend rien.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Ouvrez un compte chez ASPSMS ou Swisscom (Enterprise SMS), ou utilisez un service compatible.')}</li>
        <li>{t('Copiez ici l’identifiant et la clé API du compte. La clé reste chiffrée sur cet appareil.')}</li>
        <li>{t('Activez : les cartes Autopilote proposent alors l’envoi, vous validez d’un clic.')}</li>
      </ol>
    </details>
    <div className="reminder-charges__fees">
      <Field label={t('Fournisseur')}>
        <select value={draft.provider} disabled={locked} onChange={event => setDraft({ ...draft, provider: event.target.value as SmsSettings['provider'] })}>
          <option value="aspsms">ASPSMS</option>
          <option value="swisscom">Swisscom Enterprise SMS</option>
          <option value="generic">{t('Service compatible (JSON)')}</option>
        </select>
      </Field>
      <Field label={t('Expéditeur')} hint={t('11 lettres au plus, ou votre numéro +41…')}><input value={draft.sender} maxLength={16} disabled={locked} onChange={event => setDraft({ ...draft, sender: event.target.value })} /></Field>
      {draft.provider === 'aspsms' ? <Field label="UserKey"><input autoComplete="off" spellCheck={false} value={draft.account} disabled={locked} onChange={event => setDraft({ ...draft, account: event.target.value })} /></Field> : null}
      {draft.provider === 'generic' ? <Field label={t('Adresse du service')}><input type="url" autoComplete="off" spellCheck={false} placeholder="https://…" value={draft.endpoint ?? ''} disabled={locked}
        onChange={event => setDraft({ ...draft, endpoint: event.target.value || null })} /></Field> : null}
      <Field label={draft.provider === 'aspsms' ? t('Mot de passe API') : t('Clé API')} hint={settings?.secretPresent ? t('Enregistrée sur cet appareil. Laissez vide pour la garder.') : t('Gardée chiffrée sur cet appareil, jamais envoyée à Zentra.')}>
        <input type="password" autoComplete="off" value={secret} disabled={locked} onChange={event => setSecret(event.target.value)} />
      </Field>
    </div>
    <label className="reminder-charges__interest">
      <input type="checkbox" role="switch" aria-checked={draft.enabled} checked={draft.enabled} disabled={locked} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
      <span><strong>{t('Activer les SMS')}</strong><small>{t('Désactivé tant que vous ne l’activez pas.')}</small></span>
    </label>
    <label className="reminder-charges__interest">
      <input type="checkbox" role="switch" aria-checked={draft.appointmentRemindersAuto} checked={draft.appointmentRemindersAuto} disabled={locked || !draft.enabled}
        onChange={event => setDraft({ ...draft, appointmentRemindersAuto: event.target.checked })} />
      <span><strong>{t('Envoyer les rappels de rendez-vous sans attendre mon clic')}</strong><small>{t('Règle explicite : la veille, pour les rendez-vous avec l’heure et le numéro du client.')}</small></span>
    </label>
    <div className="reminder-charges__actions">
      <Button type="button" variant="secondary" disabled={locked} onClick={() => void save()}>{saving ? t('Enregistrement…') : t('Enregistrer')}</Button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  </section>;
}
