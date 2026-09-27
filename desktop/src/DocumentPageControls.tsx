import { t, useAppLanguage } from './language';
import { documentStyleVariables, type DocumentStyle } from './documentAppearance';
import type { DocumentComposition } from './documentComposition';

type Props = { design: DocumentComposition; disabled: boolean; onChange: (value: Partial<DocumentComposition>) => void };

export function DocumentPageControls({ design, disabled, onChange }: Props) {
  useAppLanguage();
  return <fieldset className="document-page-format" disabled={disabled}>
    <legend>{t("Format de la page")}</legend>
    <div>{(['portrait', 'landscape'] as const).map(value => <button type="button" key={value} aria-pressed={(design.pageOrientation ?? 'portrait') === value} onClick={() => onChange({ pageOrientation: value })}>
      <span className="document-page-format__paper" data-document-colors data-orientation={value} aria-hidden="true"><i /><i /><i /></span>
      <strong>{value === 'portrait' ? t('Portrait') : t('Paysage')}</strong><small>{value === 'portrait' ? t('A4 · page verticale') : t('A4 · plus de largeur')}</small>
    </button>)}</div>
    <small>{t("Le contenu se répartit automatiquement sur les pages. La section de paiement QR garde sa page A4 verticale.")}</small>
  </fieldset>;
}

export function DocumentTableColors({ design, style, disabled, onChange }: Props & { style: DocumentStyle }) {
  useAppLanguage();
  const automatic = documentStyleVariables(style) as Record<string, string>;
  const customHeader = documentStyleVariables({ ...style, accentColor: design.tableHeaderColor ?? style.accentColor }) as Record<string, string>;
  const header = design.tableHeaderColor ?? (design.tableStyle === 'band' ? style.accentColor : automatic['--document-pale']);
  const onHeader = design.tableHeaderTextColor ?? (design.tableHeaderColor ? customHeader['--document-on-accent'] : design.tableStyle === 'band' ? automatic['--document-on-accent'] : design.textColor ?? '#1f2426');
  const rows = [
    ['tableHeaderColor', 'Fond des en-têtes et totaux', style.accentColor],
    ['tableHeaderTextColor', 'Texte des en-têtes et totaux', '#ffffff'],
    ['tableStripeColor', 'Fond des lignes alternées', '#eef3ef'],
    ['tableLineColor', 'Traits du tableau', '#d9dedb'],
  ] as const;
  return <details className="design-studio__advanced">
    <summary>{t("Personnaliser les couleurs du tableau")}</summary>
    <p className="design-studio__hint">{t("Les couleurs automatiques suivent votre présentation. Pour le texte des en-têtes, le contraste s’adapte au fond jusqu’à ce que vous choisissiez une couleur.")}</p>
    <div className="document-table-sample" data-document-colors aria-label={t("Échantillon des couleurs du tableau")} style={{ borderColor: design.tableLineColor ?? '#d9dedb' }}>
      <div style={{ background: header, color: onHeader }}><strong>{t("Description")}</strong><strong>CHF</strong></div>
      <div style={{ background: design.tableStyle === 'striped' ? design.tableStripeColor ?? automatic['--document-pale'] : '#fff', color: design.textColor ?? '#1f2426' }}><span>{t("Votre prestation")}</span><span>250.00</span></div>
    </div>
    <fieldset disabled={disabled}>{rows.map(([key, label, fallback]) => <div className="document-table-color" key={key}>
      <label className="design-studio__color">{t(label)}<input type="color" data-design-control={label} aria-label={t(label)} value={design[key] ?? fallback} onChange={e => onChange({ [key]: e.target.value })} /></label>
      <button type="button" className="design-studio__automatic" disabled={disabled || !design[key]} onClick={() => onChange({ [key]: undefined })}>{t("Automatique")}<span className="sr-only"> : {t(label)}</span></button>
    </div>)}</fieldset>
    {design.tableStyle !== 'striped' && <p className="design-studio__hint">{t("Le fond des lignes apparaît avec la présentation « Lignes alternées ».")}</p>}
    <small>{t("Vérifiez la lisibilité de vos couleurs dans l’aperçu PDF.")}</small>
  </details>;
}
