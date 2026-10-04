import { useMemo, useRef, useState } from 'react';
import { Camera, Paperclip, X } from 'lucide-react';
import { Button, ErrorPanel } from './ui';
import { FileClassification } from './AutomationDocument';
import { fileSizeLabel, PROJECT_FILE_ACCEPT, projectFileError } from './projectDocuments';
import { t, useAppLanguage } from './language';
import { projectFileMessageText } from './projectLanguage';
import { createLocalValidationError } from './localValidation';

export function ProjectFilesPicker({ files, onChange, disabled = false }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const language = useAppLanguage();
  const documentInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  // These strings come only from projectFileError before any read/upload RPC.
  // Native and transport errors elsewhere retain their original provenance.
  const validationError = useMemo(() => errors.length
    ? createLocalValidationError(errors.map(projectFileValidationMessage).join(' '), language)
    : null, [errors, language]);
  function add(selected: FileList | null) {
    if (disabled || !selected) return;
    const accepted: File[] = [];
    const errors: string[] = [];
    for (const file of Array.from(selected)) {
      const invalid = projectFileError(file);
      if (invalid) errors.push(invalid);
      else if (![...files, ...accepted].some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) accepted.push(file);
    }
    onChange([...files, ...accepted]);
    setErrors(errors);
  }
  return <div className="project-file-picker">
    <div className="project-file-picker__actions">
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => documentInput.current?.click()}><Paperclip size={17} /> {t('Ajouter des documents')}</Button>
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => photoInput.current?.click()}><Camera size={17} /> {t('Ajouter une photo')}</Button>
    </div>
    <input ref={documentInput} type="file" accept={PROJECT_FILE_ACCEPT} multiple hidden disabled={disabled} onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
    <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" hidden disabled={disabled} onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
    <p className="project-file-picker__hint">{t('PDF, photos, Word, Excel, PowerPoint, OpenDocument, TXT et CSV · 25 Mo par fichier.')}</p>
    {validationError ? <ErrorPanel message={validationError} /> : null}
    {files.length ? <ul className="project-pending-files">{files.map((file, index) => <li key={`${file.name}-${file.lastModified}-${index}`}>
      <span><strong>{file.name}</strong><small>{fileSizeLabel(file.size)}</small></span>
      {index===0&&<FileClassification file={file}/>}
      <Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={t('Retirer {name}', { name: file.name })} onClick={() => onChange(files.filter((_, current) => current !== index))}><X size={17} /></Button>
    </li>)}</ul> : null}
  </div>;
}

function projectFileValidationMessage(source: string): string {
  const empty = /^([\s\S]+) est vide\.$/.exec(source);
  if (empty) return t('{name} est vide. Choisissez un fichier non vide.', { name: empty[1] });
  const tooLarge = /^([\s\S]+) dépasse 25 Mo\.$/.exec(source);
  if (tooLarge) return t('{name} dépasse 25 Mo. Choisissez un fichier de 25 Mo ou moins.', { name: tooLarge[1] });
  const unsupported = /^Le format de ([\s\S]+) n’est pas pris en charge\.$/.exec(source);
  if (unsupported) return t('Le format de {name} n’est pas pris en charge. Choisissez un format indiqué ci-dessus.', { name: unsupported[1] });
  return projectFileMessageText(source);
}
