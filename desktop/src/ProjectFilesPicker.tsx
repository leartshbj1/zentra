import { useEffect, useRef, useState } from 'react';
import { businessWorkspaceLocked, holdBusinessActivity } from './businessWorkspaceLock';
import { Camera, Paperclip, X } from 'lucide-react';
import { Button, ErrorPanel } from './ui';
import { fileSizeLabel, PROJECT_FILE_ACCEPT, projectFileError } from './projectDocuments';

export function ProjectFilesPicker({ files, onChange, disabled = false }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const documentInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const pickerActivity = useRef<(() => void) | null>(null);
  useEffect(() => () => pickerActivity.current?.(), []);
  function choose(input: HTMLInputElement | null) {
    if (!input || disabled || businessWorkspaceLocked()) return;
    pickerActivity.current?.();
    const release = holdBusinessActivity();
    const finished = () => {
      input.removeEventListener('change', finished);
      input.removeEventListener('cancel', finished);
      pickerActivity.current = null;
      release();
    };
    pickerActivity.current = finished;
    input.addEventListener('change', finished);
    input.addEventListener('cancel', finished);
    try { input.click(); } catch (reason) { finished(); throw reason; }
  }
  function add(selected: FileList | null) {
    if (!selected) return;
    const accepted: File[] = [];
    const errors: string[] = [];
    for (const file of Array.from(selected)) {
      const invalid = projectFileError(file);
      if (invalid) errors.push(invalid);
      else if (![...files, ...accepted].some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) accepted.push(file);
    }
    onChange([...files, ...accepted]);
    setError(errors.join(' '));
  }
  return <div className="project-file-picker">
    <div className="project-file-picker__actions">
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => choose(documentInput.current)}><Paperclip size={17} /> Ajouter des documents</Button>
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => choose(photoInput.current)}><Camera size={17} /> Ajouter une photo</Button>
    </div>
    <input ref={documentInput} type="file" accept={PROJECT_FILE_ACCEPT} multiple hidden onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
    <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" hidden onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
    <p className="project-file-picker__hint">PDF, photos, Word, Excel, PowerPoint, OpenDocument, TXT et CSV · 25 Mo par fichier.</p>
    {error ? <ErrorPanel message={error} /> : null}
    {files.length ? <ul className="project-pending-files">{files.map((file, index) => <li key={`${file.name}-${file.lastModified}-${index}`}>
      <span><strong>{file.name}</strong><small>{fileSizeLabel(file.size)}</small></span>
      <Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={`Retirer ${file.name}`} onClick={() => onChange(files.filter((_, current) => current !== index))}><X size={17} /></Button>
    </li>)}</ul> : null}
  </div>;
}
