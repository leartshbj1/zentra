import type { AppLanguage } from './language';

type RestorePresentationState = 'resume' | 'rolledBack' | 'committed' | 'sourceFiles';
type RestoreCopy = { title: string; message: string; action: string };

// UI only. These are the public envelopes emitted by the native restore engine,
// not a general error classifier or evidence that an operation may be replayed.
const pending = 'Une restauration doit être reprise avant de rouvrir l’entreprise. Les fichiers disponibles sont conservés. Fermez puis rouvrez Zentra. Si le problème persiste, contactez le support sans supprimer le dossier local.';
const committed = 'La restauration est terminée et les données sont enregistrées. Le nettoyage des anciennes copies n’a pas pu se terminer. Fermez puis rouvrez Zentra pour le reprendre. Si ce message revient, contactez le support.';
const sourceFiles = 'Les pièces jointes à restaurer sont inaccessibles. Les fichiers disponibles sont conservés.';

const copy: Record<AppLanguage, Record<RestorePresentationState, RestoreCopy>> = {
  fr: {
    resume: { title: 'Restauration à reprendre', message: 'La restauration est incomplète. Les fichiers disponibles sont conservés.', action: 'Fermez puis rouvrez Zentra. Si le problème persiste, contactez le support sans supprimer le dossier local.' },
    rolledBack: { title: 'Restauration annulée', message: 'Les données précédentes ont été rétablies.', action: 'Vérifiez la sauvegarde choisie. Si le problème persiste, communiquez le code d’incident au support.' },
    committed: { title: 'Restauration terminée', message: 'Les données restaurées sont enregistrées. Le nettoyage des anciennes copies reste à terminer.', action: 'Fermez puis rouvrez Zentra pour terminer le nettoyage. Si ce message revient, contactez le support.' },
    sourceFiles: { title: 'Pièces jointes à vérifier', message: 'Les pièces jointes de cette sauvegarde ne peuvent pas être lues. Les fichiers disponibles sont conservés.', action: 'Vérifiez l’accès à la sauvegarde et au dossier. Si le problème persiste, communiquez le code d’incident au support.' },
  },
  de: {
    resume: { title: 'Wiederherstellung fortsetzen', message: 'Die Wiederherstellung ist unvollständig. Die verfügbaren Dateien bleiben erhalten.', action: 'Schliessen Sie Zentra und öffnen Sie es erneut. Falls das Problem bleibt, kontaktieren Sie den Support, ohne den lokalen Ordner zu löschen.' },
    rolledBack: { title: 'Wiederherstellung abgebrochen', message: 'Die vorherigen Daten wurden wiederhergestellt.', action: 'Prüfen Sie die gewählte Sicherung. Falls das Problem bleibt, geben Sie dem Support den Vorfallcode.' },
    committed: { title: 'Wiederherstellung abgeschlossen', message: 'Die wiederhergestellten Daten sind gespeichert. Die Bereinigung der alten Kopien ist noch nicht abgeschlossen.', action: 'Schliessen Sie Zentra und öffnen Sie es erneut, um die Bereinigung abzuschliessen. Falls diese Meldung erneut erscheint, kontaktieren Sie den Support.' },
    sourceFiles: { title: 'Anhänge prüfen', message: 'Die Anhänge dieser Sicherung können nicht gelesen werden. Die verfügbaren Dateien bleiben erhalten.', action: 'Prüfen Sie den Zugriff auf die Sicherung und den Ordner. Falls das Problem bleibt, geben Sie dem Support den Vorfallcode.' },
  },
  it: {
    resume: { title: 'Ripristino da riprendere', message: 'Il ripristino è incompleto. I file disponibili sono conservati.', action: 'Chiudi e riapri Zentra. Se il problema persiste, contatta l’assistenza senza eliminare la cartella locale.' },
    rolledBack: { title: 'Ripristino annullato', message: 'I dati precedenti sono stati ripristinati.', action: 'Verifica il backup scelto. Se il problema persiste, comunica il codice incidente all’assistenza.' },
    committed: { title: 'Ripristino completato', message: 'I dati ripristinati sono salvati. La pulizia delle vecchie copie deve ancora essere completata.', action: 'Chiudi e riapri Zentra per completare la pulizia. Se questo messaggio ricompare, contatta l’assistenza.' },
    sourceFiles: { title: 'Verifica gli allegati', message: 'Gli allegati di questo backup non possono essere letti. I file disponibili sono conservati.', action: 'Verifica l’accesso al backup e alla cartella. Se il problema persiste, comunica il codice incidente all’assistenza.' },
  },
  en: {
    resume: { title: 'Restore needs to resume', message: 'The restore is incomplete. Available files are retained.', action: 'Close and reopen Zentra. If the problem continues, contact support without deleting the local folder.' },
    rolledBack: { title: 'Restore cancelled', message: 'The previous data has been restored.', action: 'Check the selected backup. If the problem continues, give the incident code to support.' },
    committed: { title: 'Restore completed', message: 'The restored data is saved. Cleanup of the old copies is still pending.', action: 'Close and reopen Zentra to finish cleanup. If this message appears again, contact support.' },
    sourceFiles: { title: 'Check the attachments', message: 'The attachments in this backup cannot be read. Available files are retained.', action: 'Check access to the backup and folder. If the problem continues, give the incident code to support.' },
  },
};

function restoreState(reason: unknown): RestorePresentationState | null {
  // Native IPC rejects with a string. Do not inspect arbitrary objects, HTTP
  // metadata, locally authored field Errors or uncertain-creation wrappers.
  if (typeof reason !== 'string') return null;
  const raw = reason.trim();
  if (raw === pending) return 'resume';
  if (raw === committed) return 'committed';
  if (raw === sourceFiles) return 'sourceFiles';
  // Historical native rollback envelopes used Validation. No other Validation
  // message is promoted; names/quotes or a restore phrase inside a cause do not match.
  const legacy = raw.startsWith('Champ invalide : ');
  const envelope = legacy ? raw.slice('Champ invalide : '.length) : raw;
  if (/^La restauration a été annulée et les données précédentes ont été rétablies\. Cause : [\s\S]+$/.test(envelope)) return 'rolledBack';
  if (/^La restauration a échoué \([\s\S]+\) et le retour automatique est incomplet \([\s\S]+\)\.(?: Récupérez la sauvegarde de sécurité : [\s\S]+\.)?$/.test(envelope)) return 'resume';
  // Only the candidate Restore variant emits these two public envelopes.
  if (legacy) return null;
  if (/^La préparation de la restauration a échoué \([\s\S]+\) et le retour automatique est incomplet \([\s\S]+\)\. Les fichiers disponibles sont conservés ; fermez puis rouvrez Zentra avant de reprendre\.$/.test(envelope)) return 'resume';
  if (/^L’installation de la sauvegarde a échoué \([\s\S]+\) et les données précédentes n’ont pas pu être entièrement rétablies \([\s\S]+\)\.$/.test(envelope)) return 'resume';
  return null;
}

/** A display-only decision. Keep the original reason for details and incidents. */
export function restoreErrorPresentation(reason: unknown, language: AppLanguage): (RestoreCopy & { state: RestorePresentationState }) | null {
  const state = restoreState(reason);
  return state ? { state, ...copy[language][state] } : null;
}
