import type { DocumentDesignKind } from './documentAppearance';

export type DocumentDesignTool = {
  id: string; label: string; description: string; keywords: string;
  panel: 'style' | 'layout' | 'text'; selector: string;
  zone?: 'intro' | 'closing' | 'footerText'; exclude?: DocumentDesignKind[];
};
const field = (label: string) => `[aria-label="${label}"]`;
export const documentDesignTools: DocumentDesignTool[] = [
  { id: 'font', label: 'Police du document', description: 'Changer la police de tous les textes courants.', keywords: 'ecriture caractere typographie inter literata helvetica times courier', panel: 'style', selector: field('Police du document') },
  { id: 'body-size', label: 'Taille du texte', description: 'Rendre les textes plus grands ou plus discrets.', keywords: 'petit grand point lisible caracteres', panel: 'style', selector: field('Taille du texte') },
  { id: 'title-font', label: 'Police du titre', description: 'Donner au titre une police différente du reste de la page.', keywords: 'typographie titre ecriture caractere', panel: 'style', selector: field('Police du titre') },
  { id: 'title-size', label: 'Taille du titre', description: 'Agrandir ou réduire le titre du document.', keywords: 'titre grand petit', panel: 'style', selector: field('Taille du titre') },
  { id: 'accent', label: 'Couleur principale', description: 'Choisir la couleur qui signe votre présentation.', keywords: 'couleurs palette personnalisee vert bleu rouge', panel: 'style', selector: field('Couleur personnalisée') },
  { id: 'ink', label: 'Couleur du texte courant', description: 'Changer la couleur du texte en dehors des passages déjà mis en forme.', keywords: 'couleurs ecriture noir', panel: 'style', selector: field('Couleur du texte du document') },
  { id: 'title-ink', label: 'Couleur du titre', description: 'Choisir une couleur spécifique pour le titre.', keywords: 'couleurs titre', panel: 'style', selector: field('Couleur du titre du document') },
  { id: 'logo', label: 'Déplacer le logo', description: 'À gauche, au centre, à droite ou masqué.', keywords: 'image position emplacement logo cacher masquer', panel: 'layout', selector: field('Position du logo') },
  { id: 'logo-size', label: 'Taille du logo', description: 'Agrandir le logo en conservant ses proportions.', keywords: 'image dimension largeur petit grand logo', panel: 'layout', selector: field('Taille du logo') },
  { id: 'logo-gap', label: 'Espace sous le logo', description: 'Rapprocher ou éloigner les coordonnées du logo.', keywords: 'logo espacement vide marge', panel: 'layout', selector: field('Espace sous le logo') },
  { id: 'company', label: 'Alignement de l’entreprise', description: 'Placer le nom, l’adresse et les coordonnées.', keywords: 'entete entreprise adresse aligner centrer', panel: 'layout', selector: field('Alignement de l’entreprise') },
  { id: 'recipient', label: 'Alignement du destinataire', description: 'Placer les informations du client ou du collaborateur.', keywords: 'client employe collaborateur destinataire adresse centrer', panel: 'layout', selector: field('Alignement du destinataire'), exclude: ['accounts'] },
  { id: 'title-align', label: 'Alignement du titre', description: 'Aligner le titre à gauche, au centre ou à droite.', keywords: 'titre centrer position', panel: 'layout', selector: field('Alignement du titre') },
  { id: 'margins', label: 'Marges de la page', description: 'Régler l’espace entre les bords et le contenu.', keywords: 'marges bord mise page largeur', panel: 'layout', selector: field('Marges') },
  { id: 'top', label: 'Début du contenu', description: 'Décaler le contenu par rapport au haut de la page.', keywords: 'marge haut entete descendre monter', panel: 'layout', selector: field('Début du contenu') },
  { id: 'spacing', label: 'Interligne', description: 'Aérer les lignes de texte ou les rapprocher.', keywords: 'espacement lignes texte serrer aerer', panel: 'layout', selector: field('Interligne') },
  { id: 'blocks', label: 'Espace entre les blocs', description: 'Rapprocher les parties du document ou leur laisser plus d’espace.', keywords: 'espacement bloc compact aerer mise page', panel: 'layout', selector: field('Espace entre les blocs') },
  { id: 'table', label: 'Présentation du tableau', description: 'En-tête coloré, lignes alternées ou traits discrets.', keywords: 'tableau bordures lignes design', panel: 'layout', selector: field('Présentation du tableau') },
  { id: 'rows', label: 'Hauteur des lignes du tableau', description: 'Choisir un tableau compact ou aéré.', keywords: 'tableau espace lignes hauteur compact', panel: 'layout', selector: field('Espace dans les lignes') },
  { id: 'header', label: 'Couleur des en-têtes et totaux', description: 'Personnaliser le fond des lignes mises en valeur.', keywords: 'tableau couleur fond total titre entete', panel: 'layout', selector: field('Fond des en-têtes et totaux') },
  { id: 'stripes', label: 'Couleur des lignes alternées', description: 'Personnaliser le fond utilisé par le tableau à lignes alternées.', keywords: 'tableau couleur fond alterne ligne', panel: 'layout', selector: field('Fond des lignes alternées') },
  { id: 'totals', label: 'Position des totaux', description: 'Afficher le total après le tableau ou après les conditions.', keywords: 'total montant haut bas avant apres conditions', panel: 'layout', selector: field('Position des totaux'), exclude: ['accounts'] },
  { id: 'intro', label: 'Écrire une introduction', description: 'Ajouter un texte mis en forme avant le tableau.', keywords: 'texte introduction avant gras italique souligner liste', panel: 'text', zone: 'intro', selector: '[role="textbox"]' },
  { id: 'closing', label: 'Mettre en forme les conditions', description: 'Écrire, mettre en gras, souligner et créer des listes.', keywords: 'texte conditions notes complementaires gras italique souligner puces numerotees police passage', panel: 'text', zone: 'closing', selector: '[role="textbox"]' },
  { id: 'footer', label: 'Écrire le pied de page', description: 'Personnaliser le texte répété sur chaque page.', keywords: 'texte bas pied page signature remerciement', panel: 'text', zone: 'footerText', selector: '[role="textbox"]' },
];
function searchable(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
export function findDocumentDesignTools(query: string, kind: DocumentDesignKind): DocumentDesignTool[] {
  const words = searchable(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return documentDesignTools.filter(tool => !tool.exclude?.includes(kind)).map(tool => tool.id === 'closing' && kind === 'accounts'
    ? { ...tool, label: 'Mettre en forme le commentaire', description: 'Ajouter vos explications après les comptes.', keywords: `${tool.keywords} bilan commentaire comptes` } : tool)
    .filter(tool => words.every(word => searchable(`${tool.label} ${tool.description} ${tool.keywords}`).includes(word)));
}
