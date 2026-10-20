import { useRef } from 'react';
import { useNavigationSelection } from './useNavigationSelection';
import { t, useAppLanguage } from './language';

export type BankArea = 'account' | 'cash' | 'treasury';

/** Banque : le compte, la caisse et la trésorerie, au même endroit. */
export function BankAreaTabs({ active, onChange }: { active: BankArea; onChange: (area: BankArea) => void }) {
  useAppLanguage();
  const navigation = useRef<HTMLElement>(null);
  useNavigationSelection(navigation, active, false);
  return <nav ref={navigation} className="sales-tabs" aria-label={t('Banque et caisse')}>
    <span className="sales-tabs__selection" aria-hidden="true" />
    {([['account', 'Compte bancaire'], ['cash', 'Caisse'], ['treasury', 'Trésorerie']] as const).map(([id, label]) =>
      <button key={id} type="button" className={active === id ? 'is-active' : ''} aria-current={active === id ? 'page' : undefined} onClick={() => onChange(id)}>{t(label)}</button>,
    )}
  </nav>;
}
