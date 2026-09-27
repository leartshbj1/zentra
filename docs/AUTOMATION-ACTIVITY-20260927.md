# Journal Automation — détails des factures

Le résumé conserve ses compteurs journaliers dans le calendrier Europe/Zurich. Le journal renvoie désormais les vingt dernières factures reçues ou importées de l’entreprise, y compris celles des jours précédents et celles encore à vérifier. Les documents ignorés sont exclus. Le tri repose sur la date d’import lorsqu’elle existe, sinon la date de réception, puis l’identifiant.

La projection expose seulement l’identifiant de facture Gestion, le fournisseur, la référence, le montant extrait avec sa devise, l’expéditeur et le nom de pièce jointe. Aucun texte complet, justificatif, compte bancaire, secret de réservation ou clé de stockage n’est inclus. Une extraction historique malformée laisse ces champs inconnus au lieu de casser l’activité de l’entreprise. Les anciennes propriétés restent compatibles.

L’application doit présenter le montant comme lu sur la facture, pas comme une écriture comptable validée. Seul le résultat d’import confirmé détermine le statut « comptabilisée automatiquement ». Un simple enregistrement reste distinct. Les détails s’ouvrent à la demande ; le lien direct utilise l’identifiant du document importé.

Validation locale : 18 tests projection/service/activité, puis 67 tests fournisseur/Automation (dont 14 communs au premier lot), TypeScript et compilation de production réussis. SQLite et services externes fictifs. Aucune arrivée de courriel réelle, activation de planificateur, correction du HTTP 500 ou publication d’un binaire n’est déduite de ces résultats.
