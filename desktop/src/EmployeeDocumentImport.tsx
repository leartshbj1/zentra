import { useEffect, useRef, useState } from 'react';
import { FileUp, LoaderCircle, X } from 'lucide-react';
import { Button } from './ui';
import type { EmployeeDocumentDraft } from './employeeDocumentDraft';
import type { payrollLocalAi as LocalAi } from './payrollLocalAi';
import './EmployeeDocumentImport.css';

export function EmployeeDocumentImport({ onRead, disabled }: { onRead: (draft: EmployeeDocumentDraft) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const engine = useRef<typeof LocalAi | null>(null);
  const generation = useRef(0);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState({ label: '', percent: null as number | null });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => { generation.current++; engine.current?.cancel(); }, []);
  function cancel() {
    generation.current++; engine.current?.cancel(); setWorking(false); setNotice('Lecture annulée. Vous pouvez compléter le formulaire.');
  }
  async function read(file: File) {
    const current = ++generation.current;
    let unsubscribe: (() => void) | undefined;
    setWorking(true); setError(''); setNotice(''); setProgress({ label: 'Ouverture du document', percent: null });
    try {
      if (file.size === 0 || file.size > 20 * 1024 * 1024) throw new Error('Choisissez un PDF ou une image de moins de 20 Mo.');
      if (!/\.(?:pdf|png|jpe?g|webp)$/i.test(file.name)) throw new Error('Formats acceptés : PDF, PNG, JPG et WEBP.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { prepareImageForAnalysis, renderPdfPages } = await import('./localPdfPreview');
      let extractedText = '';
      let imageUrls: string[] = [];
      if (/\.pdf$/i.test(file.name)) {
        const { extractPayrollPdfTextByPage } = await import('./payrollPdfText');
        const text = await extractPayrollPdfTextByPage(bytes.slice(), 3);
        if (text.pageCount > 3) throw new Error('Sélectionnez une seule fiche de salaire, de trois pages au maximum.');
        extractedText = text.pages.join('\n\n');
        if (extractedText.replace(/\s/g, '').length < 80) imageUrls = (await renderPdfPages(bytes.slice(), 3)).pages;
      } else {
        const source = URL.createObjectURL(file);
        try { imageUrls = [await prepareImageForAnalysis(source)]; } finally { URL.revokeObjectURL(source); }
      }
      if (generation.current !== current) return;
      const { payrollLocalAi } = await import('./payrollLocalAi');
      if (generation.current !== current) return;
      engine.current = payrollLocalAi;
      unsubscribe = payrollLocalAi.onProgress(value => { if (generation.current === current) setProgress(value); });
      const result = await payrollLocalAi.analyze({ imageUrls, extractedText });
      if (generation.current !== current) return;
      if (!result.employeeDraft || !Object.keys(result.employeeDraft.fields).length) throw new Error('Aucune information exploitable n’a été retrouvée. Essayez une photo plus nette ou remplissez le formulaire.');
      onRead(result.employeeDraft);
      setNotice('Lecture terminée. Vérifiez les champs préremplis, puis complétez les informations manquantes.');
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'La lecture a échoué. Réessayez avec une autre fiche.');
    } finally {
      unsubscribe?.();
      if (generation.current === current) { engine.current?.cancel(); engine.current = null; setWorking(false); }
    }
  }
  return <section className="employee-document-import" aria-label="Remplir depuis une fiche de salaire">
    <div><strong>Vous avez déjà une fiche de salaire ?</strong><p>Importez-la pour préremplir ce formulaire. Le document reste sur votre appareil.</p></div>
    <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void read(file); }} />
    {working ? <div className="employee-document-import__reading"><span role="status"><LoaderCircle className="spin" size={16} /> {progress.label}{progress.percent === null ? '' : ` · ${Math.round(progress.percent)} %`}</span><Button type="button" variant="ghost" onClick={cancel}><X size={15} /> Annuler</Button></div>
      : <Button type="button" variant="secondary" disabled={disabled} onClick={() => input.current?.click()}><FileUp size={16} /> Lire une fiche de salaire</Button>}
    {!working && !notice && !error ? <small>Qwen · téléchargement initial de 429 Mo, puis lecture locale.</small> : null}
    {notice ? <p className="employee-document-import__notice" role="status">{notice}</p> : null}
    {error ? <p className="employee-document-import__error" role="alert">{error}</p> : null}
  </section>;
}
