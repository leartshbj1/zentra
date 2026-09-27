import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import { isMobileRuntime } from './mobileRuntime';
import { desktopApi } from './bridge';
import type { PdfExportReceipt as Receipt } from './pdfExportDelivery';
import { t, useAppLanguage } from './language';

export function PdfExportReceipt({ result, disabled, onBusyChange }: { result: Receipt; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  useAppLanguage();
  const flight = useRef(false);
  const [notice, setNotice] = useState(result.deliveryWarning || 'Le PDF a été enregistré.');
  useEffect(() => { setNotice(result.deliveryWarning || 'Le PDF a été enregistré.'); }, [result]);
  async function share() {
    if (flight.current || disabled) return;
    flight.current = true; onBusyChange(true);
    try { await desktopApi.shareExistingExport(result.path); setNotice('Partage du PDF ouvert.'); }
    catch { setNotice('Le partage n’a pas abouti. Votre PDF est conservé : appuyez sur « Partager le PDF » pour réessayer.'); }
    finally { flight.current = false; onBusyChange(false); }
  }
  return <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <p role="status">{t(notice)}</p>
    {!isMobileRuntime() && <small>{result.path}</small>}
    {(isMobileRuntime() || result.deliveryWarning) && <Button variant="secondary" disabled={disabled} onClick={() => void share()}>{t('Partager le PDF')}</Button>}
  </div>;
}
