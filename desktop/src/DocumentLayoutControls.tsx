import { CustomMeasureOption } from './DocumentPrecisionControls';
import type { DocumentComposition } from './documentComposition';
import type { DocumentDesignKind } from './documentAppearance';

type Props = { design: DocumentComposition; kind: DocumentDesignKind; disabled: boolean; onChange: (value: Partial<DocumentComposition>) => void };

/** Presentation-only controls; native rendering keeps the business values and pagination. */
export function DocumentLayoutControls({ design, kind, disabled, onChange }: Props) {
  const closing = kind === 'accounts' ? 'commentaire' : 'conditions';
  return <details className="design-studio__advanced">
    <summary>Ajuster les blocs et les espacements</summary>
    <p className="design-studio__hint">Déplacez les blocs sans avoir à les aligner à la main. Le contenu passe automatiquement à la page suivante si nécessaire.</p>
    <fieldset disabled={disabled}>
      <legend>En-tête</legend>
      <label>Alignement de l’entreprise<select aria-label="Alignement de l’entreprise" value={design.companyAlign ?? 'left'} onChange={e => onChange({ companyAlign: e.target.value as DocumentComposition['companyAlign'] })}>
        <option value="left">À gauche</option><option value="center">Au centre</option><option value="right">À droite</option>
      </select><small>Nom, adresse et coordonnées de l’entreprise. Le logo garde sa propre position.</small></label>
      {kind !== 'accounts' && <label>Alignement du destinataire<select aria-label="Alignement du destinataire" value={design.recipientAlign ?? 'left'} onChange={e => onChange({ recipientAlign: e.target.value as DocumentComposition['recipientAlign'] })}>
        <option value="left">À gauche</option><option value="center">Au centre</option><option value="right">À droite</option>
      </select><small>{kind === 'payslips' ? 'Identité et informations du collaborateur.' : 'Nom et adresse du client.'}</small></label>}
      <label>Espace sous le logo<select aria-label="Espace sous le logo" value={design.logoGap ?? 14} onChange={e => onChange({ logoGap: Number(e.target.value) })}>
        <CustomMeasureOption value={design.logoGap ?? 14} choices={[0,7,14,24,36]} />{[0,7,14,24,36].map(n => <option value={n} key={n}>{n === 0 ? 'Aucun espace ajouté' : `${n} pt`}</option>)}
      </select></label>
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Rythme de la page</legend>
      <label>Début du contenu<select aria-label="Début du contenu" value={design.topMarginMm ?? ''} onChange={e => onChange({ topMarginMm: e.target.value ? Number(e.target.value) : undefined })}>
        <option value="">Suivre les marges du document</option>{design.topMarginMm != null && <CustomMeasureOption value={design.topMarginMm} choices={[12,15,20,25,35,45]} unit="mm depuis le haut" />}{[12,15,20,25,35,45].map(n => <option value={n} key={n}>{n} mm depuis le haut</option>)}
      </select><small>Modifie la marge du haut sur les pages du document.</small></label>
      <label>Espace entre les blocs<select aria-label="Espace entre les blocs" value={design.blockSpacing ?? 1} onChange={e => onChange({ blockSpacing: Number(e.target.value) })}>
        <CustomMeasureOption value={design.blockSpacing ?? 1} choices={[.5,1,1.5,2]} unit="×" /><option value="0.5">Rapproché</option><option value="1">Équilibré</option><option value="1.5">Aéré</option><option value="2">Très aéré</option>
      </select><small>L’interligne et l’espace des lignes du tableau se règlent séparément.</small></label>
      <label className="design-studio__choice"><input type="checkbox" aria-label={`Commencer les ${closing === 'commentaire' ? 'commentaires' : closing} sur une nouvelle page`} checked={design.closingOnNewPage === true} onChange={e => onChange({ closingOnNewPage: e.target.checked })} />{kind === 'accounts' ? 'Commentaire sur une nouvelle page' : 'Conditions sur une nouvelle page'}</label>
      <small>Une nouvelle page est ajoutée seulement si cette zone contient du texte.</small>
    </fieldset>
  </details>;
}

export function DocumentInkControls({ design, disabled, onChange, accentColor }: Omit<Props, 'kind'> & { accentColor: string }) {
  const rgb = [1,3,5].map(index => parseInt(accentColor.slice(index, index + 2), 16));
  const luminance = rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126,.7152,.0722][index], 0);
  const automaticTitle = `#${rgb.map(value => Math.round(luminance > .18 ? value * .45 : value).toString(16).padStart(2, '0')).join('')}`;
  return <details className="design-studio__advanced">
    <summary>Couleurs du titre et du texte</summary>
    <p className="design-studio__hint">Choisissez-les indépendamment des tableaux. Les passages déjà colorés conservent leur mise en forme.</p>
    <fieldset disabled={disabled}>
      <label className="design-studio__color">Texte du document<input type="color" aria-label="Couleur du texte du document" value={design.textColor ?? '#1f2426'} onChange={e => onChange({ textColor: e.target.value })} /></label>
      <button type="button" className="design-studio__automatic" onClick={() => onChange({ textColor: undefined })}>Texte en couleur automatique</button>
      <label className="design-studio__color">Titre du document<input type="color" aria-label="Couleur du titre du document" value={design.titleColor ?? automaticTitle} onChange={e => onChange({ titleColor: e.target.value })} /></label>
      <button type="button" className="design-studio__automatic" onClick={() => onChange({ titleColor: undefined })}>Titre assorti aux tableaux</button>
      <small>Vérifiez le contraste sur le fond blanc dans l’aperçu.</small>
    </fieldset>
  </details>;
}
