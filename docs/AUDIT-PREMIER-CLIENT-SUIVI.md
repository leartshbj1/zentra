# Préparation du premier client — suivi du 27 septembre 2026

Objectif : traiter les vingt points de l’audit, avec des preuves adaptées. Aucun statut global « prêt » n’est déduit d’un build ou de tests simulés.

Audit : `C:/Users/alb/Documents/ChatGPT/chantier/outputs/audit-premier-client-20260927/AUDIT.md`. Les captures de référence utilisent l’interface réelle et une entreprise fictive ; elles ne sont pas une recette des appareils installés.

| # | Travail et état actuel | Preuve nécessaire pour fermer le point |
|---|---|---|
| 1 | HTTP 500 de synchronisation : diagnostic structurel publié (source `3125e26e`, Sites 272). Cause précise encore à isoler. Sans trafic de collaboration, l’absence de nouvelle erreur ne prouve pas une résolution. | Deux comptes/installations réels : devis, facture, encaissement, remboursement, soldes identiques, coupure et reprise sans doublons. |
| 2 | Référence de requête, opération, version du client, statut/code/ressource amont et durée publiés ; aucun contenu métier ni secret dans ces journaux. | Compléter dernier succès, alertes et suivi des travaux autonomes ; corréler un échec réel. |
| 3 | Automation autonome : GitHub précédemment bloqué par facturation ; SQL Supabase disponible mais application non démontrée. `SUPPORT_MAIL_BACKGROUND_ENABLED` absent à la révision 36. | Observer un travail planifié sans application ouverte, ses reprises, limites et idempotence. |
| 4 | Artefacts 1.90.2 publiés précédemment ; macOS ad hoc/non notarisé, IPA non signé, APK avec certificat de test existant. Windows local encore 1.90.0 à l’audit. | Signature et distribution adaptées, installations/mises à jour réelles des quatre plateformes, données conservées. |
| 5 | Parcours premier client complet à réaliser ; les tests isolés ne suffisent pas. | Inscription extérieure, e-mail reçu, récupération, Stripe en mode test, droits, invitation, second appareil, sauvegarde/restauration. |
| 6 | Corrigé localement : consultation des trois formulaires de base des paramètres sans bloquer la réception. Réception recréant leurs valeurs tout en gardant la rubrique. Toute saisie, même dans une rubrique ensuite cachée, protège le brouillon jusqu’à quitter les paramètres. Statut d’attente distinct du transfert. | Parcours Chromium/WebKit passés ; binaire et vérification réelle à terminer. Les autres éditeurs restent protégés. |
| 7 | Densité mobile des listes, agenda et Support à réduire. | Contenu utile prioritaire, filtres secondaires accessibles, plusieurs langues et tailles. |
| 8 | Corrigé localement : assistant réservé dans la barre d’outils au lieu de recouvrir le contenu ; aide des modales conservée. | Ouverture vérifiée en navigateur ; recette binaire à terminer. |
| 9 | États et compteurs de réception fournisseur à harmoniser. | Comptages reçus/à vérifier/comptabilisés cohérents et vérification de lot avec exceptions. |
| 10 | Activité d’Automation à rendre plus concrète. | Événements avec document, montant, origine, résultat et lien ; aucune économie inventée. |
| 11 | Démarrage et sélection des espaces à clarifier. | Même compte sur deux appareils avec des données ; choix explicite et aucun mélange d’entreprises. |
| 12 | Paie, distinction salariés/membres et assurances à clarifier. | Erreur compréhensible, réglage direct et retour au brouillon ; aucun taux contractuel deviné. |
| 13 | Corrigé localement : messagerie, variables, modèles, aperçus, erreurs connues et états en FR/DE/IT/EN ; contenu client inchangé. | Parcours quatre langues passés ; compléter messages inconnus observés et publier le binaire. |
| 14 | Corrigé localement : onglets/variables e-mail 44 px minimum, mots non coupés ; nouvelle rubrique révélée sous la barre fixe, aussi sur ordinateur. | Poursuivre les autres écrans ; ne pas annoncer une conformité globale. |
| 15 | Taille du texte à ajouter sans zoom global ni suppression du zoom des documents. | Taille 200 %, redistribution mobile et clavier. |
| 16 | Périodes des indicateurs, unités, absences et écrans vides à préciser. | Stock/flux distingués, prochaine action unique, aucun faux zéro comptable. |
| 17 | Secret SMTP par appareil et modèles par entreprise indiqués et traduits. Acceptation SMTP distincte de la livraison. | Stratégie partagée/OAuth, droits, erreurs et recette de livraison ; aucun secret synchronisé en clair. |
| 18 | Structure et performance à traiter par mesures et extractions ciblées. | Démarrage/navigation, mémoire, chargement des langues, CSS inutilisé prouvé et absence de régression. |
| 19 | CSP/HSTS à renforcer selon l’hébergement. | Observation compatible Vinext puis politique appliquée et parcours authentifiés/Stripe vérifiés. |
| 20 | Corrigé localement : texte de sauvegarde `.zentra`, anciennes sauvegardes de test explicitement exclues, checklist de préparation actualisée avec domaine/contact actuels. Validateur natif existant inchangé. | Inclure ces textes dans la prochaine livraison ; recette restauration du format courant encore à exécuter. |

## Preuves du lot d’interface

- `desktop/.qa/first-client-interface/proof.json` : 28 parcours Chromium/Edge et WebKit, 320/390/1440 px, FR/DE/IT/EN. Aucune transmission SMTP réelle.
- `desktop/.qa/company1711/proof.json` : quatre parcours de synchronisation simulée, émission/encaissement, 2,77 à 2,95 s, écran visible et saisies préservées. Ce délai n’est pas une mesure de production.
- `desktop/tests/outgoing-mail-journey.mjs` : quatre parcours de connexion simulée, contrat IPC strict, mot de passe conservé, double clic sans double envoi, erreur incertaine sans renvoi automatique.
- 38 tests unitaires ciblés réussis, puis 18 tests affectés et compilation web/TypeScript repassés après les dernières corrections. Revue Impeccable : correction du message d’attente résolue, disposition `ship` limitée à cette correction ; documentation dans `INTERFACE-PREMIER-CLIENT-20260927.md`. Intégration aux binaires encore en attente.
- `desktop/.qa/first-client-interface/settings-review-proof.json` : quatre reprises après sauvegarde partielle, détail d’attente visible dans le panneau Compte, protection du brouillon caché et réception après sortie des paramètres. Aucune sauvegarde automatique du brouillon n’est impliquée.

## Limites d’accès constatées

Le contrôle navigateur échoue à l’initialisation avec `failed to write kernel assets` (chemin introuvable). Aucun accès administrateur Supabase n’a été rétabli par ce moyen. Les secrets serveur sont masqués par l’API Sites et ne sont pas reconstitués. Les corrections locales, tests simulés et diagnostics structurels restent possibles.
