import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from './ui';
import { t, useAppLanguage } from './language';
import {
  automationState,
  featureReady,
  type AutomationDecision,
} from './automation';
import { DocumentClassification, useAutomation } from './AutomationControls';
import type { Workspace } from './types';

export async function localDocumentExcerpt(file: File) {
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw Error('Choisissez un document de moins de 20 Mo.');
  if (/\.(txt|csv)$/i.test(file.name))
    return (await file.slice(0, 12000).text()).slice(0, 1800);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { prepareImageForAnalysis, renderPdfPages } =
    await import('./localPdfPreview');
  let images: string[] = [];
  if (/\.pdf$/i.test(file.name)) {
    const { extractPayrollPdfTextByPage } = await import('./payrollPdfText');
    const text = await extractPayrollPdfTextByPage(bytes.slice(), 2);
    const excerpt = text.pages.join('\n');
    if (excerpt.replace(/\s/g, '').length >= 60) return excerpt.slice(0, 1800);
    images = (await renderPdfPages(bytes.slice(), 2)).pages;
  } else if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
    const url = URL.createObjectURL(file);
    try {
      images = [await prepareImageForAnalysis(url)];
    } finally {
      URL.revokeObjectURL(url);
    }
  } else throw Error('Lecture disponible pour PDF, images, TXT et CSV.');
  const { readPayslipImages } = await import('./payrollOcr');
  return (
    await readPayslipImages(
      images,
      new URL('.', document.baseURI).href,
      () => {},
    )
  ).text.slice(0, 1800);
}
export function AutomationDocumentReader({
  onRead,
  disabled = false,
}: {
  onRead: (text: string) => void;
  disabled?: boolean;
}) {
  useAppLanguage();
  const input = useRef<HTMLInputElement>(null),
    generation = useRef(0);
  const [available, setAvailable] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void automationState().then((value) => {
      if (live)
        setAvailable(
          featureReady(value, 'document_routing') ||
            featureReady(value, 'supplier_routing'),
        );
    });
    return () => {
      live = false;
      generation.current++;
    };
  }, []);
  if (!available) return null;
  return (
    <div className="automation-file">
      <Button
        type="button"
        variant="secondary"
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        <FileUp size={16} />
        {t(busy ? 'Lecture du document…' : 'Préparer depuis un document')}
      </Button>
      <input
        ref={input}
        hidden
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.txt"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          const ticket = ++generation.current;
          setBusy(true);
          setError('');
          void localDocumentExcerpt(file)
            .then((text) => {
              if (ticket === generation.current) onRead(text);
            })
            .catch(() => {
              if (ticket === generation.current)
                setError(
                  'La lecture n’a pas abouti. Vous pouvez remplir le formulaire.',
                );
            })
            .finally(() => {
              if (ticket === generation.current) setBusy(false);
            });
        }}
      />
      {error && <p role="status">{t(error)}</p>}
    </div>
  );
}
export function FileClassification({ file }: { file: File }) {
  const [text, setText] = useState('');
  useEffect(() => {
    let active = true;
    void automationState().then(async (state) => {
      if (!active || !featureReady(state, 'document_routing')) return;
      try {
        const excerpt = await localDocumentExcerpt(file);
        if (active) setText(excerpt);
      } catch {
        /* Adding the original document remains available. */
      }
    });
    return () => {
      active = false;
    };
  }, [file]);
  return text ? (
    <DocumentClassification
      text={text}
      identity={`${file.name}:${file.size}:${file.lastModified}`}
    />
  ) : null;
}
export function SupplierRouting({
  text,
  workspace,
  disabled,
  onApply,
  onDecision,
}: {
  text: string;
  workspace: Workspace;
  disabled: boolean;
  onApply: (ids: Record<string, string | null>) => void;
  onDecision: (value: AutomationDecision | null) => void;
}) {
  useAppLanguage();
  const decision = useAutomation(
    'supplier_routing',
    text.trim() ? { text: text.slice(0, 1800) } : null,
  );
  const latest = useRef(onDecision);
  latest.current = onDecision;
  useEffect(() => latest.current(decision), [decision]);
  if (decision?.status !== 'suggestion' || !decision.resourceIds) return null;
  const ids = decision.resourceIds;
  const supplier = workspace.suppliers.find(
      (v) => v.id === ids.supplier && !v.archivedAt,
    ),
    project = workspace.projects.find((v) => v.id === ids.project);
  const category = workspace.settings?.work.costCategories.find(
    (v) => v === ids.expense_category,
  );
  if (!supplier && !project && !category) return null;
  return (
    <div className="automation-choice">
      <span className="automation-eyebrow">{t('Suggestion Zentra')}</span>
      <strong>
        {[supplier?.name, project?.name, category].filter(Boolean).join(' · ')}
      </strong>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() =>
          onApply({
            supplier: supplier?.id ?? null,
            project: project?.id ?? null,
            category: category ?? null,
          })
        }
      >
        {t('Reprendre dans le brouillon')}
      </Button>
      <small>
        {t(
          'Vérifiez puis enregistrez le brouillon. Aucun paiement n’est déclenché.',
        )}
      </small>
    </div>
  );
}
