import { useState } from 'react';
import { t, useAppLanguage } from './language';
import { saveDigest, savedDigest } from './morningDigest';
import { formatDate } from './utils';

/** Réglage personnel : le résumé du matin par e-mail, désactivé par défaut. */
export function MorningDigestSetting({ organizationId, disabled }: { organizationId: string; disabled: boolean }) {
  useAppLanguage();
  const [saved, setSaved] = useState(() => savedDigest(organizationId));
  function toggle(enabled: boolean) {
    const next = { ...saved, enabled };
    saveDigest(organizationId, next);
    setSaved(next);
    window.dispatchEvent(new Event('zentra-digest-changed'));
  }
  return <fieldset className="automation-settings__functioning" disabled={disabled}>
    <legend>{t('Pour vous')}</legend>
    <label className="automation-settings__toggle">
      <span>
        <strong>{t('Résumé du matin par e-mail')}</strong>
        <small>{t('Chaque matin à 7 h, la liste des actions à valider. Seuls leur nombre et leurs titres (8 au plus) sont envoyés au serveur Zentra pour composer l’e-mail.')}</small>
      </span>
      <input type="checkbox" role="switch" aria-checked={saved.enabled} checked={saved.enabled} onChange={(event) => toggle(event.target.checked)} />
    </label>
    {saved.enabled ? <p className="automation-settings__current-mode">{saved.emailConfigured === false
      ? t('L’envoi d’e-mails n’est pas encore ouvert sur le serveur Zentra. Le résumé partira dès qu’il le sera.')
      : saved.lastSentOn ? t('Dernier envoi le {date}.', { date: formatDate(saved.lastSentOn) }) : t('Le premier résumé partira demain matin.')}</p> : null}
  </fieldset>;
}
