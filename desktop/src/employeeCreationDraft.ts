import type {AppLanguage} from './language';

// The existing business fields and controlled mappings remain unchanged.
export const employeeDraftFields = [
  'name', 'employeeNumber', 'role', 'email', 'phone',
  'addressLine1', 'addressLine2', 'postalCode', 'city', 'canton',
  'country', 'employmentRate', 'contractualWeeklyHours', 'employmentStart', 'employmentEnd',
  'employmentContractKind', 'salaryMode', 'grossSalary', 'hourlyCost', 'status',
  'notes', 'birthDate', 'avsNumber', 'iban', 'lppAssessmentYear',
  'lppAnnualSalary', 'lppExceptionCode', 'lppExceptionEvidenceReference', 'acOpeningYear', 'acOpeningBasis',
  'laaOpeningYear', 'laaOpeningBasis', 'referenceAgeDate', 'avsAllowanceWaived', 'smallSalaryAssessmentYear',
  'smallSalarySector', 'smallSalaryEmployeeRequestedContributions', 'smallSalaryDecisionDate', 'smallSalaryOpeningGross', 'smallSalaryOpeningContributedBasis',
  'smallSalaryEvidenceReference', 'draftStep', 'draftDeferAnnual',
] as const;
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const validEmployeeCreationId=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value);
/** Legacy values remain readable, but UI must ask before attaching a new UUID. */
export const validCreationEmployeeDraft=(value:Record<string,string>)=>value.creationId===undefined||validEmployeeCreationId(value.creationId);
// Stable discriminants independent of the current interface language.
export const EMPLOYEE_CREATION_UNCONFIRMED='La création du collaborateur n’est pas confirmée.';
export const EMPLOYEE_LOCAL_DRAFT_UNSAVED='employee-local-draft-unsaved';
export const employeeCreationRecovery:Record<AppLanguage,{title:string;message:string;instruction:string;legacy:string;prepare:string;storage:string}>={
  fr:{title:'Création du collaborateur à vérifier',message:'La création de cette fiche n’a pas été confirmée. Votre saisie est conservée.',instruction:'Vérifiez la liste des collaborateurs avant de réessayer. Si la fiche existe déjà, ouvrez-la pour la contrôler ou la modifier.',legacy:'Ce brouillon ancien ne permet pas de retrouver une précédente création. Vérifiez la liste des collaborateurs avant de préparer une nouvelle fiche.',prepare:'Préparer une nouvelle fiche',storage:'Cette nouvelle fiche ne peut pas être conservée sur cet appareil. Réessayez sa sauvegarde locale avant de l’enregistrer.'},
  de:{title:'Mitarbeitererstellung prüfen',message:'Die Erstellung dieses Mitarbeiters wurde nicht bestätigt. Ihre Eingaben bleiben gespeichert.',instruction:'Prüfen Sie die Mitarbeiterliste, bevor Sie es erneut versuchen. Falls der Mitarbeiter bereits vorhanden ist, öffnen Sie seinen Eintrag zum Prüfen oder Bearbeiten.',legacy:'Dieser ältere Entwurf kann einer früheren Erstellung nicht zugeordnet werden. Prüfen Sie die Mitarbeiterliste, bevor Sie einen neuen Eintrag vorbereiten.',prepare:'Neuen Eintrag vorbereiten',storage:'Dieser neue Eintrag kann auf diesem Gerät nicht gespeichert werden. Versuchen Sie zuerst, den lokalen Entwurf erneut zu speichern.'},
  it:{title:'Verifica la creazione del collaboratore',message:'La creazione di questa scheda non è stata confermata. I dati inseriti sono conservati.',instruction:'Controlla l’elenco dei collaboratori prima di riprovare. Se la scheda esiste già, aprila per verificarla o modificarla.',legacy:'Questa vecchia bozza non permette di identificare una creazione precedente. Controlla l’elenco dei collaboratori prima di preparare una nuova scheda.',prepare:'Prepara una nuova scheda',storage:'Questa nuova scheda non può essere conservata sul dispositivo. Riprova a salvare la bozza locale prima di registrarla.'},
  en:{title:'Check the employee creation',message:'The creation of this employee has not been confirmed. Your entries are retained.',instruction:'Check the employee list before trying again. If the employee already exists, open their record to review or edit it.',legacy:'This older draft cannot identify a previous creation. Check the employee list before preparing a new record.',prepare:'Prepare a new record',storage:'This new record cannot be retained on this device. Retry saving the local draft before creating it.'},
};
