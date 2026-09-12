export function bankFileName(path: string): string {
  const name = path.split(/[\\/]/).pop() || path;
  try { return decodeURIComponent(name); } catch { return name; }
}

export function bankProblemHelp(message: string): { title: string; text: string } {
  if (/namespace|camt\.05|xml|DOCTYPE|encodage/i.test(message)) return { title: 'Le format du relevé doit être vérifié', text: 'Depuis votre banque, téléchargez un relevé XML camt.053, puis choisissez ce nouveau fichier. Ouvrez les détails ci-dessous si la banque doit vérifier le format.' };
  if (/clôtur|clotur|exercice fermé/i.test(message)) return { title: 'La période de ce paiement est clôturée', text: 'La date bancaire tombe dans une période comptable fermée. Revenez à la comptabilité pour vérifier cette période avant de reprendre le rapprochement.' };
  if (/solde|dépasse|supérieur|montant/i.test(message)) return { title: 'Le montant doit être vérifié', text: 'Comparez le versement au reste dû de la facture. Revenez aux mouvements pour vérifier la facture choisie et les paiements déjà enregistrés.' };
  if (/compte|liaison|comptabilité/i.test(message)) return { title: 'Un réglage du compte est à vérifier', text: 'Revenez aux mouvements, vérifiez que le compte appartient à cette entreprise et ouvrez la configuration comptable si elle est incomplète.' };
  return { title: 'L’opération demande une vérification', text: 'Vos choix sont conservés. Consultez le message ci-dessous, puis réessayez ou revenez aux mouvements pour actualiser les données.' };
}
