import { useRef } from 'react';
import { useNavigationSelection } from './useNavigationSelection';
import { t, useAppLanguage } from './language';

export type SalesView = 'quotes' | 'orders' | 'invoices';

export function SalesTabs({ active, onChange }: { active: SalesView; onChange: (view: SalesView) => void }) {
  useAppLanguage();
  const navigation = useRef<HTMLElement>(null);
  useNavigationSelection(navigation, active, false);
  return <nav ref={navigation} className="sales-tabs" aria-label={t('Cycle de vente')}>
    <span className="sales-tabs__selection" aria-hidden="true" />
    {([['quotes', 'Devis'], ['orders', 'Commandes'], ['invoices', 'Factures']] as const).map(([id, label]) =>
      <button key={id} type="button" className={active === id ? 'is-active' : ''} aria-current={active === id ? 'page' : undefined} onClick={() => onChange(id)}>{t(label)}</button>,
    )}
  </nav>;
}
