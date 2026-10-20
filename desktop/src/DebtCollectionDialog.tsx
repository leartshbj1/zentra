import { useState } from 'react';
import { desktopApi } from './bridge';
import { debtCollectionIssues, debtCollectionXml, type DebtCollectionRequest } from './debtCollection';
import { t, useAppLanguage } from './language';
import type { Workspace } from './types';
import { Button, Modal } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import './reminder-charges.css';

/**
 * Récapitulatif de la réquisition de poursuite. Rien n'est déposé : le
 * fichier enregistré et ces données servent au dépôt (EasyGov, eSchKG ou papier).
 */
export function DebtCollectionDialog({ request, invoiceNumber, onClose, onSaved }: {
  request: DebtCollectionRequest;
  invoiceNumber: string;
  onClose: () => void;
  onSaved: (workspace: Workspace, path: string) => void;
}) {
  useAppLanguage();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const issues = debtCollectionIssues(request);
  const party = (value: { name: string; street: string; postalCode: string; city: string }) => [value.name, value.street, `${value.postalCode} ${value.city}`.trim()].filter(Boolean).join('\n');
  const rows: [string, string][] = [
    [t('Créancier'), party(request.creditor)],
    [t('Débiteur'), party(request.debtor)],
    [t('Créance'), formatMoney(request.claimCents, request.currency)],
    [t('Intérêts'), request.interestRateBp > 0 && request.interestFrom ? t('{rate} % dès le {date}', { rate: (request.interestRateBp / 100).toString().replace('.', ','), date: formatDate(request.interestFrom) }) : t('Aucun')],
    [t('Frais de rappel'), request.feesCents > 0 ? formatMoney(request.feesCents, request.currency) : t('Aucun')],
    [t('Titre de la créance'), request.title],
  ];
  async function save() {
    setSaving(true); setError('');
    try {
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const result = await desktopApi.exportDebtCollectionRequest({
        invoiceId: request.invoiceId,
        fileName: `requisition-poursuite-${invoiceNumber}.xml`,
        xml: debtCollectionXml(request, createdAt),
        claimCents: request.claimCents,
        interestRateBp: request.interestRateBp,
        interestFrom: request.interestFrom,
        feesCents: request.feesCents,
      });
      if (result) onSaved(result.workspace, result.path);
    } catch (reason) {
      setError(errorMessage(reason, t('La réquisition n’a pas pu être enregistrée.')));
    } finally { setSaving(false); }
  }
  return <Modal title={t('Réquisition de poursuite')} description={t('Facture {number} · après la dernière relance restée sans réponse.', { number: invoiceNumber })} onClose={onClose} dismissible={!saving}>
    <div className="debt-collection">
      <dl>{rows.map(([label, value]) => <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {issues.length > 0 && <ul role="alert">{issues.map((issue) => <li key={issue}>{t(issue)}</li>)}</ul>}
      <p>{t('Zentra ne dépose rien. Enregistrez le fichier, puis déposez la réquisition sur EasyGov.swiss, par un service eSchKG ou avec le formulaire de l’office des poursuites du débiteur.')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <Button type="button" variant="secondary" disabled={saving} onClick={onClose}>{t('Fermer')}</Button>
        <Button type="button" disabled={saving || issues.length > 0} onClick={() => void save()}>{saving ? t('Enregistrement…') : t('Enregistrer la réquisition')}</Button>
      </div>
    </div>
  </Modal>;
}
