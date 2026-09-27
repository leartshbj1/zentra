import { AlignLeft, Image, LayoutTemplate, PanelBottom, Table, Type } from 'lucide-react';
import { t, useAppLanguage } from './language';

export type DesignSection = 'logo' | 'title' | 'intro' | 'table' | 'closing' | 'footerText';
export function DocumentDesignMap({ onSelect, accounts }: { onSelect: (section: DesignSection) => void; accounts: boolean }) {
  useAppLanguage();
  const sections = [
    ['logo', Image, 'Logo', 'Position et taille'], ['title', Type, 'Titre', 'Police et style'],
    ['intro', AlignLeft, 'Introduction', 'Avant le tableau'], ['table', Table, 'Mise en page', 'Tableau et espacements'],
    ['closing', LayoutTemplate, accounts ? 'Commentaire' : 'Conditions', 'Après le tableau'],
    ['footerText', PanelBottom, 'Pied de page', 'Sur chaque page'],
  ] as const;
  return <nav className="design-map" aria-label={t('Éléments du document')}>
    <p>{t('Que souhaitez-vous personnaliser ?')}</p>
    <div>{sections.map(([section, Icon, label, description]) => <button type="button" key={section} onClick={() => onSelect(section)}>
      <Icon size={19} aria-hidden="true" /><strong>{t(label)}</strong><small>{t(description)}</small>
    </button>)}</div>
  </nav>;
}
