# Amélioration continue de Zentra — 12 septembre 2026

Objectif en cours : rendre chaque catégorie compréhensible et vérifier les parcours complets, les données persistées et le comportement mobile. Ce suivi ne signifie pas que l'application est entièrement validée pour tous les usages clients.

## Lot : comprendre les compléments et les salaires horaires

La priorité est revenue à la création de paie à la demande de l'utilisateur. Les changements de ce lot partent de `24d92fb` sur la base de livraison 1.54.0.

- **Montants soumis aux assurances.** Le passage à la vérification ouvre une question à la fois lorsqu'un montant est inconnu. Un exemple distingue le salaire soumis du montant retenu. Les parts AVS/AI/APG et chômage sont regroupées suivant les règles de partage déjà présentes dans l'éditeur. Les contrats distincts gardent leurs propres montants ; aucun montant inconnu n'est remplacé par zéro.
- **Corrections.** Les réponses restent disponibles au retour à la question précédente, y compris une réponse pas encore confirmée. Après modification des éléments du brut, les bases manuelles confirmées demandent une nouvelle vérification. Les champs de salaire sont contrôlés avant les réglages d'assurance, afin d'éviter une erreur de champ caché comme première réponse.
- **Salaire horaire.** Un calcul heures × tarif brut reporte explicitement le montant et son détail sur une seule ligne de salaire. La virgule décimale est acceptée et le résultat est arrondi au centime. Le coût interne de projet n'est jamais utilisé comme tarif salarial. Une modification des heures ou du tarif doit être reportée avant calcul ou sauvegarde ; le message ouvre directement le calcul horaire.
- **Explications adaptées.** L'introduction distingue le salaire mensuel prérempli, le salaire à renseigner et le calcul horaire. L'assistant de l'application reçoit aussi l'étape réelle du guide de montants.

Validation du lot : **116 fichiers / 926 tests d'interface réussis**, TypeScript et compilation Vite réussis. Les 12 scénarios de `payroll-salary-entry-journey.mjs` couvrent Edge et WebKit à 320, 390 et 1440 px : prime, bases partagées, modification du brut, retour en arrière, erreur puis réessai d'enregistrement, salaire horaire, tarif indépendant du coût et remplacement sans doublon. Les 10 scénarios de première fiche/configuration de pension ont également été rejoués. Données exclusivement synthétiques ; les captures mobiles ont été inspectées.

L'intégration au dossier principal conserve sa classification des revenus et les autres travaux existants. TypeScript et 67 tests ciblés y passent. Ses 12 scénarios de saisie passent également : la recette vide explicitement une base pour exercer le guide, car ce dossier sait déjà classer les compléments ordinaires. Le premier salaire horaire peut demander de reprendre les cotisations devenues applicables une fois le montant connu. Sauvegarde des fichiers avant intégration : `.qa/payroll-entry-20260912-before/`.

Les nouveaux composants n'ajoutent aucune dépendance. Le module `WorkspaceApp` compilé atteint environ 744 ko minifiés ; le découpage reste à améliorer. Le moteur natif et les taux ne sont pas modifiés dans ce lot. La validation sur une installation réelle et la construction des nouveaux binaires restent à faire : **aucun nouvel installateur ou IPA n'est publié par ce lot**.

## Lot : reprendre son salaire et retrouver ses enregistrements

Base isolée : `dac39ed`, dernière version Windows livrée 1.54.0. Branche de travail : `codex/app-quality-20260912`. Les modifications sont également reportées par fusion à trois versions dans le dossier principal, en conservant ses travaux sur les revenus de paie et la synchronisation. Le schéma natif de la base de livraison reste 59 ; celui des travaux non publiés du dossier principal reste distinct.

- **Fiches de salaire.** Le bouton de sauvegarde partielle est accessible dès l'étape du salaire, sans devoir provoquer une erreur. Un brouillon peut être rouvert, corrigé et sauvegardé sous le même identifiant avant la fin des réglages. Les informations déjà enregistrées dans les assurances restent disponibles.
- **Protection des calculs.** La sauvegarde sans cotisations ne s'applique pas à une fiche contenant déjà des cotisations persistées, ni à une fiche validée/comptabilisée/payée. Le bouton de fermeture et Échap sont désactivés pendant l'écriture. Une tentative refusée conserve la saisie ; les clics rapprochés partagent la même sauvegarde.
- **Liste de paie.** Le filtre « Brouillons · à compléter » retrouve les fiches à reprendre. Le net reste affiché « À calculer ». La sauvegarde d'un brouillon ne valide pas la paie et ne permet pas son paiement.
- **Clients, catalogue, fournisseurs, collaborateurs, heures et dépenses.** Les créations/modifications/archives distinguent maintenant une commande native réussie d'une lecture interrompue. L'interface relit les données sans recommencer la commande.
- **Planning et chronomètre.** La même protection couvre les tâches, jalons, changements d'état, suppressions et démarrage/arrêt du pointage. Elle ne remplace pas le contrôle transactionnel ou les identifiants de requête propres aux opérations financières.
- **Début d'un parcours.** Lorsqu'une création demande un client, un fournisseur, un collaborateur, un projet actif ou des réglages confirmés, l'explication est visible sous le bouton. L'action voisine ouvre le bon formulaire ou la rubrique précise des paramètres. Le bouton inutilisable dans l'état vide des projets est supprimé. Ces raccourcis respectent la lecture seule.

## Preuves de ce lot

Les recettes navigateur utilisent uniquement des données synthétiques, sans compte ni paie de client.

| Vérification | Résultat |
| --- | --- |
| Base avant modifications | 115 fichiers, 835 tests d'interface réussis |
| Après modifications | 115 fichiers, 910 tests d'interface réussis |
| Compilation TypeScript et Vite | Réussies sur la base isolée |
| `payroll-draft-continuity-journey.mjs` | Edge 320/390/1440 px, WebKit 390 px ; reprise, échec/réessai, double clic, filtre et cotisations historiques préservées |
| `payroll-first-payslip-journey.mjs` | 10 scénarios Edge/WebKit réussis, dont configuration complète et création d'un collaborateur depuis la fiche |
| `entity-recovery-journey.mjs` | 320/390/1440 px ; panne de lecture persistante, un seul client créé, formulaire retrouvé avec les mêmes coordonnées |
| `workflow-help-journey.mjs` | 320/390/1440 px ; client ajouté avant le projet, rubrique de facturation réellement visible dans l'écran, accès fournisseur/projets et lecture seule préservée |
| Navigation et largeur des pages | 16 catégories à 320/390/1440 px, 48 parcours sans débordement horizontal ni erreur JavaScript |
| Persistance SQLite du brouillon | Test natif `incomplete_payroll_draft_can_be_reopened_and_updated_without_duplicates` réussi : même fiche, même date de création, montant et notes corrigés, aucune ligne dupliquée |
| Ensemble des tests natifs sur la base de livraison | 647 réussis, 0 échec, 2 recettes HTTPS explicitement ignorées ; 821,73 secondes |

Les deux recettes natives ignorées concernent une sauvegarde/restauration HTTPS entre deux installations avec autorisation de test, et le rafraîchissement HTTPS public de licence réservé au contrôle de publication. Les protections locales passent ; ces deux parcours externes ne sont pas attestés par cette campagne.

Après fusion dans le dossier principal, TypeScript et les 13 scénarios navigateur de reprise de brouillon, aide aux prérequis et récupération de client passent également. Les 159 tests ciblés de paie/récupération y ont réussi avant le dernier ajout des raccourcis.
Le test natif de reprise du même brouillon passe également dans ce dossier, avec sa classification des revenus non publiée. Ses champs de revenu ordinaires sont explicitement renseignés dans la version du test reportée ; les autres travaux existants sont conservés.

Les logs et images de ces vérifications se trouvent dans `.qa/` du dossier de travail isolé. Les tests de refus de commandes et de lecture interrompue de `workspaceMutation.test.ts` vérifient séparément les appels réels du bridge natif ; la recette navigateur vérifie l'interaction et la récupération affichée.

## Suite de l'audit, par catégorie

| Catégorie | Couverture actuelle de ce lot | Travail restant |
| --- | --- | --- |
| Paie et collaborateurs | Parcours première fiche, correction et reprise du brouillon ; persistance native ciblée | Essais avec une entreprise de recette sur l'application installée ; intégration contrôlée des travaux natifs sur la classification des revenus |
| Clients, catalogue et fournisseurs | Récupération après écriture, création/édition du client, navigation mobile | Vérifier les parcours d'import, d'archivage et les relations commerciales de bout en bout |
| Projets, planning, documents et photos | Commandes de planning protégées ; écrans accessibles | Synchronisation réelle entre deux appareils, pièces jointes hors ligne et conflits ; intégrer les évolutions de synchronisation isolément |
| Devis, factures, acomptes et commandes | Navigation, protections communes des mutations | Nouvelle recette complète devis → acompte → solde, export et règlements sur un profil de recette |
| Achats, stocks, banque et comptabilité | Tests du bridge, campagne native générale et navigation | Vérifier les imports bancaires, justificatifs et clôtures dans l'interface sur un profil de recette |
| TVA et certificat annuel | Moteur non modifié par ce lot | Revalider les exemples métier et les exports contre les règles applicables ; aucun statut de certification Swissdec n'est déduit de tests |
| Paramètres, sauvegardes et assistant | Navigation et compilation | Restauration sur une installation distincte, Qwen en conditions réelles et configuration des e-mails de production |
| Windows, macOS, iOS et Android | Interface partagée testée en navigateur ; compilation web réussie | Construire et vérifier chaque binaire, installation et mise à niveau avant toute annonce de disponibilité sur sa plateforme |

## Distribution

Ce lot est intégré au code ; il n'est pas encore publié comme nouvel installateur ou IPA. La version précédemment livrée reste 1.54.0 pour Windows et 1.53.0 pour l'IPA non signé. Le présent audit n'atteste ni installation client, ni nouvelles versions macOS/Android.

Le premier chargement contient encore un module `WorkspaceApp` d'environ 732 ko minifiés. Son découpage et les temps de réponse sur appareil mobile restent à examiner, en maintenant l'accès hors ligne aux fonctionnalités.
