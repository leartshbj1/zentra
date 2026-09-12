import { AlignLeft, Image, LayoutTemplate, PanelBottom, Table, Type } from 'lucide-react';

export type DesignSection = 'logo' | 'title' | 'intro' | 'table' | 'closing' | 'footerText';
export function DocumentDesignMap({ onSelect, accounts }: { onSelect: (section: DesignSection) => void; accounts: boolean }) {
  const sections = [
    ['logo', Image, 'Logo', 'Position et taille'], ['title', Type, 'Titre', 'Police et style'],
    ['intro', AlignLeft, 'Introduction', 'Avant le tableau'], ['table', Table, 'Mise en page', 'Tableau et espacements'],
    ['closing', LayoutTemplate, accounts ? 'Commentaire' : 'Conditions', 'Après le tableau'],
    ['footerText', PanelBottom, 'Pied de page', 'Sur chaque page'],
  ] as const;
  return <nav className="design-map" aria-label="Éléments du document">
    <p>Que souhaitez-vous personnaliser ?</p>
    <div>{sections.map(([section, Icon, label, description]) => <button type="button" key={section} onClick={() => onSelect(section)}>
      <Icon size={19} aria-hidden="true" /><strong>{label}</strong><small>{description}</small>
    </button>)}</div>
  </nav>;
}
