import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { Button, Modal } from './ui';
import { createModuleLoader } from './moduleLoader';
import { diagnosticOperation, resolveErrorIncident } from './diagnostics';
import { ErrorGuidance } from './ErrorGuidance';
import { useAppLanguage, type AppLanguage } from './language';
import './deferred-view.css';

const diagnosticNames = [
  'StyledDocumentPreview', 'DetailedPayslipForm', 'DocumentEditor', 'PairedInvoiceEditor', 'QuoteInvoiceFolder',
  'QuoteConversionModal', 'InvoiceIssueDialog', 'PayslipPostingDialog', 'SupplierInvoiceReviewDialog',
  'CatalogScreen', 'CatalogItemForm', 'StockMovementForm', 'ExpenseForm', 'LegacyExpenseDetail', 'SupplierForm',
  'ClientForm', 'SupplierInvoiceDetail', 'SupplierInvoiceForm', 'SupplierPaymentForm', 'SalesOrdersScreen',
  'DeliveryNotePrintPreview', 'SalesOrderPrintPreview', 'ProjectPlanningPanel', 'ProjectFolder', 'ReportsScreen',
  'SalaryCertificates', 'DocumentDesignStudio', 'EmployeeDocumentImport', 'PayrollContributionsPanel',
  'SwissPayrollRulesPanel', 'TimeBillingWizard', 'CloudBackupPanel', 'CatalogImportWizard',
] as const;
export type DeferredViewDiagnosticName = typeof diagnosticNames[number];
const copy: Record<AppLanguage, { title: string; retained: string; persistent: string; retry: string }> = {
  fr: { title: 'Cet écran n’a pas pu s’ouvrir.', retained: 'Votre espace reste ouvert. Réessayez l’ouverture ; les informations déjà saisies dans le formulaire précédent sont conservées.', persistent: 'Si le problème persiste, revenez au formulaire précédent, enregistrez votre travail puis relancez Zentra.', retry: 'Réessayer l’ouverture' },
  de: { title: 'Dieser Bildschirm konnte nicht geöffnet werden.', retained: 'Ihr Arbeitsbereich bleibt geöffnet. Versuchen Sie es erneut; die Eingaben im vorherigen Formular bleiben erhalten.', persistent: 'Wenn das Problem bestehen bleibt, kehren Sie zum vorherigen Formular zurück, speichern Sie Ihre Arbeit und starten Sie Zentra neu.', retry: 'Öffnen erneut versuchen' },
  it: { title: 'Questa schermata non ha potuto aprirsi.', retained: 'Il tuo spazio resta aperto. Riprova ad aprire la schermata; i dati già inseriti nel modulo precedente sono conservati.', persistent: 'Se il problema persiste, torna al modulo precedente, salva il lavoro e riavvia Zentra.', retry: 'Riprova ad aprire' },
  en: { title: 'This screen could not be opened.', retained: 'Your workspace remains open. Try opening the screen again; entries in the previous form are preserved.', persistent: 'If the problem persists, return to the previous form, save your work, then restart Zentra.', retry: 'Try opening again' },
};

/** Defer optional screens without hiding the workspace or remounting a surrounding form. */
export function deferView<C extends ComponentType<any>>(
  importView: () => Promise<{ default: C }>,
  options: { label: string | Record<AppLanguage, string>; diagnosticName?: DeferredViewDiagnosticName; close?: (props: NoInfer<ComponentProps<C>>) => () => void },
): ComponentType<ComponentProps<C>> {
  type P = ComponentProps<C>;
  // A closed name identifies the screen without logging its label, URL or props.
  const name = diagnosticNames.includes(options.diagnosticName!) ? options.diagnosticName : 'optional';
  const loader = createModuleLoader(() => diagnosticOperation('navigation', `view.import.${name}`, importView));
  return function DeferredView(props: P) {
    const language = useAppLanguage();
    const labels = copy[language];
    const label = typeof options.label === 'string' ? options.label : options.label[language];
    const [module, setModule] = useState(() => loader.peek());
    const [failure, setFailure] = useState<{ reason: unknown; incidentCode: string } | null>(null);
    const [attempt, setAttempt] = useState(0);
    const statusRef = useRef<HTMLElement>(null);
    useEffect(() => {
      if (module) return;
      let active = true;
      loader.load().then(
        loaded => { if (active) { setModule(loaded); setFailure(null); } },
        reason => { if (active) setFailure({ reason, incidentCode: resolveErrorIncident(reason).code }); },
      );
      return () => { active = false; };
    }, [module, attempt]);
    if (module) {
      const Screen: ComponentType<P> = module.default;
      return <Screen {...props} />;
    }
    const content = <section ref={statusRef} tabIndex={-1} className="deferred-view" role={failure ? undefined : 'status'} aria-label={label}>
      {!failure && <LoaderCircle className="spin" size={22} aria-hidden="true" />}
      <div>
        {failure ? <>
          <ErrorGuidance error={failure.reason} incidentCode={failure.incidentCode} title={labels.title} operation="read" compact />
          <p>{labels.retained}</p><p>{labels.persistent}</p>
        </> : <strong>{label}</strong>}
      </div>
      {failure && <Button type="button" variant="secondary" onClick={() => {
        // The retry button disappears during loading; retain keyboard focus inside the dialog.
        statusRef.current?.focus({ preventScroll: true });
        setFailure(null);
        setAttempt(value => value + 1);
      }}>
        <RefreshCw size={16} /> {labels.retry}
      </Button>}
    </section>;
    return options.close ? <Modal title={label} onClose={options.close(props)}>{content}</Modal> : content;
  };
}
