import { useState } from 'react';
import { Button } from './ui';
import { t, useAppLanguage } from './language';
import { useAutomation } from './AutomationControls';
import {
  catalogHeaders,
  catalogMappingFields,
  defaultCatalogMapping,
  previewMappedCatalog,
  type CatalogMappingSource,
  type CatalogImportPreview,
} from './catalogImport';
import type { AutomationDecision } from './automation';
export function AutomationCatalogMapping({
  source,
  disabled,
  onPrepared,
}: {
  source: CatalogMappingSource;
  disabled: boolean;
  onPrepared: (
    value: CatalogImportPreview,
    decision: AutomationDecision | null,
    choices: Record<string, string>,
  ) => void;
}) {
  useAppLanguage();
  const [header, setHeader] = useState(source.headerIndex),
    [mapping, setMapping] = useState<string[]>(() =>
      defaultCatalogMapping(source, source.headerIndex),
    ),
    [error, setError] = useState('');
  const columns = catalogHeaders(source, header),
    decision = useAutomation(
      'import_mapping',
      columns.length <= 24 ? { target: 'catalog', columns } : null,
      `${source.fileName}:${header}`,
    );
  return (
    <div className="automation-map">
      <label>
        <span>{t('Ligne des titres')}</span>
        <select
          value={header}
          disabled={disabled}
          onChange={(event) => {
            const index = Number(event.target.value);
            setHeader(index);
            setMapping(defaultCatalogMapping(source, index));
            setError('');
          }}
        >
          {source.rows.slice(0, 20).map((_, index) => (
            <option value={index} key={index}>
              {index + 1}
            </option>
          ))}
        </select>
      </label>
      {decision?.status === 'suggestion' && (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            setMapping(
              columns.map((_, index) => {
                const value = decision.choices?.[`column_${index}`];
                return value && Object.hasOwn(catalogMappingFields, value)
                  ? value
                  : 'ignore';
              }),
            )
          }
        >
          {t('Reprendre les colonnes proposées')}
        </Button>
      )}
      {columns.map((label, index) => (
        <label key={index}>
          <span>{label || `${t('Colonne')} ${index + 1}`}</span>
          <select
            value={mapping[index] || 'ignore'}
            disabled={disabled}
            onChange={(event) =>
              setMapping((previous) =>
                previous.map((v, i) => (i === index ? event.target.value : v)),
              )
            }
          >
            <option value="ignore">{t('Ne pas importer')}</option>
            {Object.entries(catalogMappingFields).map(([key, label]) => (
              <option key={key} value={key}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
      ))}
      {error && <p role="alert">{t(error)}</p>}
      <Button
        type="button"
        disabled={disabled}
        onClick={() => {
          try {
            onPrepared(
              previewMappedCatalog(source, header, mapping),
              decision,
              Object.fromEntries(
                mapping.map((value, index) => [`column_${index}`, value]),
              ),
            );
            setError('');
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : 'Vérifiez les colonnes.',
            );
          }
        }}
      >
        {t('Vérifier les lignes avant import')}
      </Button>
    </div>
  );
}
