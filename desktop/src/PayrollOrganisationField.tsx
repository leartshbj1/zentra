import { useId, useState } from 'react';
import { Search, Check } from 'lucide-react';
import {
  findPayrollOrganisations,
  PAYROLL_ORGANISATION_HELP,
  PAYROLL_DIRECTORY_CHECKED_ON,
  type PayrollOrganisationKind,
} from './swissPayrollDirectory';
import './payroll-simple.css';

/** Search results are ordinary keyboard-accessible buttons; typing is always allowed. */
export function PayrollOrganisationField({
  kind,
  name,
  value,
  defaultValue = '',
  onChange,
  canton = '',
  disabled = false,
  required = false,
  error,
  dataField,
}: {
  kind: PayrollOrganisationKind;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  canton?: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  dataField?: string;
}) {
  const [local, setLocal] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = value ?? local;
  const id = useId();
  const help = PAYROLL_ORGANISATION_HELP[kind];
  const matches = findPayrollOrganisations(kind, query, canton);
  const set = (next: string) => {
    setLocal(next);
    onChange?.(next);
  };
  return (
    <div className="payroll-organisation field">
      <label htmlFor={id} className="field__label">
        {help.label}
      </label>
      <input
        id={id}
        name={name}
        data-field={dataField}
        aria-invalid={Boolean(error)}
        value={current}
        onChange={(event) => set(event.target.value)}
        disabled={disabled}
        required={required}
        maxLength={240}
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        placeholder="Nom indiqué sur votre contrat"
      />
      <span
        id={`${id}-hint`}
        className={error ? 'field__error' : 'field__hint'}
      >
        {error || help.hint}
      </span>
      <button
        type="button"
        className="payroll-text-button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={`${id}-directory`}
        onClick={() => setOpen(!open)}
      >
        <Search size={16} />
        {open ? 'Fermer la recherche' : 'Rechercher dans les caisses suisses'}
      </button>
      {open && (
        <div id={`${id}-directory`} className="payroll-directory">
          <label htmlFor={`${id}-search`}>
            Rechercher {help.label.toLocaleLowerCase('fr-CH')}
          </label>
          <input
            id={`${id}-search`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Nom, numéro ou canton"
            autoComplete="off"
            disabled={disabled}
          />
          <output className="field__hint">
            {matches.length} résultat{matches.length > 1 ? 's' : ''}
            {matches.length > 20 ? ' · Précisez le nom pour affiner.' : ''}
          </output>
          <ul>
            {matches.slice(0, 20).map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    set(entry.name);
                    setOpen(false);
                  }}
                >
                  <span>
                    {entry.name}
                    <small>
                      {entry.canton ? `${entry.canton} · ` : ''}N°{' '}
                      {entry.number}
                    </small>
                  </span>
                  {current === entry.name && <Check size={17} />}
                </button>
              </li>
            ))}
          </ul>
          {!matches.length && (
            <p>
              Aucun résultat. Vous pouvez saisir le nom exact directement dans
              le champ ci-dessus.
            </p>
          )}
          <small>
            {help.scope} Choisissez uniquement l’organisme auquel votre
            entreprise est affiliée.
          </small>
          <small>
            Répertoire vérifié le{' '}
            {PAYROLL_DIRECTORY_CHECKED_ON.split('-').reverse().join('.')}.
          </small>
          <a href={help.source} target="_blank" rel="noreferrer">
            Consulter le répertoire officiel
          </a>
        </div>
      )}
    </div>
  );
}
