import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { useCompanyAutomation } from './AutomationCompany';
import { folderLabel, savedStatementFolder, saveStatementFolder } from './autopilotStatements';
import { t, useAppLanguage } from './language';
import { Button } from './ui';

/** Dossier où Autopilote repère les relevés CAMT (Téléchargements par défaut). */
export function StatementFolderSetting({ disabled }: { disabled: boolean }) {
  useAppLanguage();
  // Préférence de cet appareil, rangée par entreprise (« local » hors compte).
  const organizationId = useCompanyAutomation().organizationId ?? 'local';
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const saved = savedStatementFolder(organizationId);
    if (saved) setFolder(saved);
    else void desktopApi.defaultStatementFolder().then((value) => { if (live) setFolder(value); });
    return () => { live = false; };
  }, [organizationId]);
  if (!folder) return null;
  return <p className="bank-statement-folder">
    {t('Autopilote repère les relevés déposés dans {folder}.', { folder: folderLabel(folder) })}{' '}
    <Button type="button" variant="ghost" size="small" disabled={disabled} onClick={async () => {
      const chosen = await desktopApi.chooseBankStatementFolder();
      if (typeof chosen === 'string' && chosen) { saveStatementFolder(organizationId, chosen); setFolder(chosen); }
    }}>{t('Changer le dossier')}</Button>
  </p>;
}
