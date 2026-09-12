# Amélioration continue de Zentra — 12 septembre 2026

Objectif en cours : rendre chaque catégorie compréhensible et vérifier les parcours complets, les données persistées et le comportement mobile. Ce suivi ne signifie pas que l'application est entièrement validée pour tous les usages clients.

## Lot : terminer une fiche de salaire sans refaire les réglages

Les corrections de contrat, de caisse et de cotisation reprennent maintenant les nouvelles cotisations applicables dans la fiche en cours après un enregistrement confirmé et une relecture réussie. Les cotisations déjà proposées puis écartées, les bases manuelles, les cumuls et les zéros explicitement saisis ne sont pas remplacés. Le contexte collaborateur/mois/date est vérifié avant la reprise. Les choix intermédiaires restent masqués pendant cette actualisation. Sur le scénario complet de première fiche, les trois actions répétées « Utiliser ces cotisations » ont disparu : quatre ouvertures de réglages restent après la saisie du contrat, au lieu de sept actions de préparation.

Le contrat de pension indique le champ exact à compléter : caisse, numéro, référence, début, fin ou confirmation de la part entreprise. Les dates incohérentes et les périodes qui ne couvrent pas la date utilisée par la fiche sont signalées avant toute écriture. La vérification de période porte sur une correction de pension ou un plan modifié ; changer une autre assurance ne crée pas cette obligation sur un plan inchangé. Le guide explique où retrouver l’information et conserve les valeurs refusées. Les erreurs apparaissent aussi sous le champ concerné, sont lisibles sur 320 px et disparaissent lors de sa correction. Le nom des caisses et les champs contrôlés par React conservent correctement le texte saisi.

Les champs de début d’année expliquent maintenant à quoi servent la date et le nom du document. La liste propose « Contrôler la fiche » et « Voir le PDF ». Le message de configuration non contrôlée ouvre directement la confirmation de contrôle dans les paramètres de paie ; ce champ est visible dans la fenêtre après le défilement. Aucun contrôle par une fiduciaire n’est confirmé automatiquement. Après contrôle explicite dans la recette, la même fiche est reprise, validée et exportée sans doublon.

Références officielles relues pour les explications : [financement de la prévoyance professionnelle — OFAS](https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle), [aperçu des cotisations — OFAS](https://www.bsv.admin.ch/fr/cotisations-apercu), [mémo AVS/AI 2.04 sur les petits salaires](https://www.ahv-iv.ch/p/2.04.f). Les taux, décisions natives et règles de comptabilisation ne changent pas dans ce lot.

Validation : **120 fichiers / 1 005 tests d’interface réussis**, TypeScript et compilation Vite réussis. Les 42 scénarios navigateur réussissent : première fiche (10), correction jusqu’au PDF (6), chemin clair et récupération (6), salaire horaire et compléments (12), aide à l’ajout d’un collaborateur (8). Edge et WebKit sont couverts, avec formats de 320 à 1440 px. Le scénario de PDF conserve une base manuelle, refuse trois erreurs de contrat avant écriture, interrompt la relecture après les deux montants de pension, puis reprend le même identifiant de fiche. Il vérifie que le contrôle professionnel reste faux tant que la recette ne le confirme pas explicitement. Les captures d’erreur, de liste et de navigation vers les réglages ont été inspectées.

Après fusion dans le dossier principal : TypeScript, 126 tests ciblés et 24 scénarios navigateur de première fiche/correction/ajout réussissent. Le test de focus attend son arrivée effective après le rendu, au lieu d’exiger un effet synchrone. Les autres travaux du dossier principal sont conservés ; sauvegarde préalable : `.qa/payroll-finish-20260912-before/`. Logs et rapports : `desktop/.qa/payroll-finish*`, `payroll-first-payslip*`, `payroll-clear-path*`, `payroll-salary-entry*` et `employee-annual-help*`.

Ce lot est **postérieur à Windows 1.55.0 et n’est pas encore publié**. Les exports navigateur utilisent exclusivement des données et réponses synthétiques ; ils ne prouvent pas une installation ni un export natif sur iPhone. Aucun nouvel installateur ou IPA n’est généré. Le schéma natif de livraison reste 59. Le module WorkspaceApp atteint environ 769 ko minifiés ; son découpage reste à améliorer.

## Lot : importer le catalogue et reprendre les coordonnées

L'import montre toutes les lignes par pages et propose un filtre sur les points à corriger. Une erreur après la ligne 100 n'est plus invisible. Chaque ligne peut être corrigée dans l'application : référence, désignation, prix, unité, type et TVA. La correction conserve le numéro de ligne d'origine et relance le contrôle des doublons. Le fichier fourni n'est pas modifié. Sur mobile, les lignes sont présentées en fiches lisibles, avec les montants et leur contrôle ; les textes et boutons de pagination ont été ajustés après inspection des captures.

Les prix d'achat texte illisibles ne deviennent plus des zéros importables. Les caractères inconnus ou devises étrangères présentes dans un prix texte sont refusés, et les montants hors de la plage native sont signalés. Un pourcentage explicite comme « 0,5 % » conserve son sens ; les fractions numériques Excel restent prises en charge. La correction d'une ligne conserve les autres erreurs du fichier. Les longueurs et caractères de contrôle sont vérifiés avant l'envoi au moteur natif.

Le choix « Conserver les fiches actuelles » affiche le bon résultat dans l'aperçu. La transformation d'un produit suivi en stock en service est signalée avant l'import en mode mise à jour. Un enregistrement confirmé suivi d'une lecture interrompue attend uniquement une relecture : le fichier n'est pas réimporté. Fichier, choix et corrections restent disponibles après un refus. Les formulaires client et fournisseur affichent leur erreur sur place et protègent la saisie pendant l'enregistrement. La recherche d'écran retrouve désormais le catalogue avec le mot « catalogue ».

Validation : **118 fichiers / 994 tests d'interface réussis**, TypeScript et compilation Vite réussis. Les 6 parcours Edge/WebKit à 320/390/1440 px importent un CSV de 105 références, corrigent la ligne 103, vérifient le mode de conservation, les prix, le stock et l'état archivé, puis provoquent un refus et plusieurs échecs de lecture sans deuxième import. Ils couvrent également le refus de création client/fournisseur, la conservation des coordonnées et l'archivage/réactivation du client. Les captures mobiles ont été inspectées après ajustement de la lisibilité.

Les deux tests natifs d'import catalogue (atomicité, références, stock et charges invalides) et le test natif d'archivage du client passent. Le moteur natif n'est pas modifié dans ce lot. Après intégration au dossier principal, TypeScript, 188 tests ciblés et les 6 parcours navigateur passent également. Sauvegarde : `.qa/directory-20260912-before/`. Les données navigateur sont synthétiques et ne remplacent pas une recette sur un profil client installé.

Ces corrections, comme le lot achats précédent, ne sont **pas encore publiées**. La version Windows distribuée reste 1.55.0. Le module `WorkspaceApp` atteint environ 763 ko minifiés ; son découpage reste nécessaire pour améliorer le premier chargement.
## Lot : achats, justificatifs et paiements compréhensibles

Les achats utilisent les catégories de départ déjà proposées par leur éditeur : l'absence de catégories personnalisées ne bloque plus la première facture. Le formulaire situe les étapes « Recopier », « Joindre l’original » et « Valider ». Après enregistrement, le justificatif devient visible et une seule action « Terminer » clôt la saisie. Les modifications ultérieures, y compris l'ajout ou le retrait de lignes, demandent à nouveau un enregistrement.

Les erreurs du brouillon, du justificatif, de la dépense et du paiement sont affichées dans le formulaire concerné. La saisie reste disponible après refus ; fermeture et champs sont protégés pendant l'opération. Le paiement accepte la virgule, explique les montants dépassant le solde et consulte le solde actualisé. Si une réponse est perdue mais que le paiement portant la même requête est retrouvé, son montant et sa date sont montrés sans proposer un second enregistrement.

Le traitement TVA choisi pour toutes les lignes et le brouillon sont désormais enregistrés dans la même transaction native. Le refus d'un classement annule aussi les autres classements, les lignes et leur audit. Le classement existant reste conservé quand aucun nouveau traitement n'est demandé. Les commandes de brouillon, import e-mail, justificatif, suppression et règlement distinguent une écriture confirmée d'une lecture interrompue ; leur reprise ne réexécute pas la commande. Aucun taux fiscal n'est modifié par ce lot.

Validation : **118 fichiers / 984 tests d'interface réussis**, TypeScript et compilation Vite réussis. Les 6 parcours `purchase-clear-journey` couvrent Edge et WebKit à 320/390/1440 px : absence de catégorie personnalisée, brouillon, erreur, classement demandé, ajout d'un justificatif, validation, paiement partiel puis solde, réponse perdue et plusieurs reprises de lecture. Les captures mobiles ont été inspectées. Les 5 parcours d'achats sans assujettissement réussissent à 320/390/768/1024/1440 px et conservent les montants HT/TVA/TTC du fournisseur.

Le test SQLite `draft_and_all_vat_choices_roll_back_together_and_retry_without_duplicates` provoque un refus du deuxième classement et vérifie l'absence de brouillon, de lignes, de classement partiel et d'audit résiduel. Il vérifie aussi la reprise identique sans doublon, l'annulation d'une modification refusée et la conservation des classements existants. Les trois tests natifs de cycle fournisseur, périodes clôturées et écart de rapprochement réussissent. Après report dans le dossier principal, TypeScript, 191 tests ciblés, les 6 parcours navigateur et le test SQLite atomique passent également. Sauvegarde avant fusion : `.qa/purchase-clear-20260912-before/`.

Ce lot est **postérieur à Windows 1.55.0 et n'est pas encore publié**. Le schéma de la base de livraison reste 59. Les autres travaux du dossier principal sont conservés. Les recettes navigateur utilisent des données synthétiques ; une installation sur un profil client réel reste à vérifier. Le module `WorkspaceApp` représente environ 756 ko minifiés et son découpage reste à améliorer.
## Lot : un chemin plus clair vers le salaire net

Le salaire du mois est séparé des réglages détaillés, rangés sous « Mes cotisations et assurances ». Un résumé annonce la prochaine action réelle : compléter les informations manquantes, confirmer une base ou calculer le net. Le collaborateur et le mois restent visibles. Les corrections ouvertes depuis le salaire utilisent aussi le guide par questions ; une ligne à classer renvoie à ses propres champs.

Le chargement interrompu des cotisations et comptes est affiché en dehors des étapes masquées. La reprise reste accessible depuis la préparation ; tant que les informations sont indisponibles, celle-ci n'annonce pas une préparation terminée et ne laisse pas calculer. Les réponses déjà enregistrées ne sont pas réécrites lors du réessai. Après le dernier réglage, le bouton « Calculer le net » rejoint directement la vérification. La vérification calculée propose une seule sauvegarde de fiche ; le brouillon reste disponible pendant la saisie.

Validation : 117 fichiers / 960 tests d'interface, TypeScript et compilation Vite réussis. Les 6 scénarios `payroll-clear-path`, 10 de première fiche et 12 de salaire horaire/compléments réussissent sur Edge et WebKit. Les erreurs de lecture, refus de sauvegarde et écriture partielle des deux cotisations de pension sont injectés dans la fixture synthétique. Les captures mobiles sont inspectées. Après intégration au dossier principal, TypeScript, 87 tests ciblés et les 16 scénarios de chemin clair/première fiche réussissent. Sauvegarde : `.qa/payroll-clear-20260912-before/`.

Le moteur natif et ses taux ne changent pas. Ces résultats ne constituent pas un essai d'installation sur iPhone. Le module `WorkspaceApp` représente environ 751 ko minifiés. La publication Windows de ce lot est suivie séparément.
## Lot : conserver les devis, corrections et règlements après une interruption

Les commandes de devis/factures, émission, conversion, solde et paiement distinguent une écriture réussie d'une lecture interrompue. Les identifiants de révision et de facture de remplacement sont récupérés avant la relecture : reprendre ouvre le document créé sans relancer la commande. Les erreurs de saisie et les refus natifs restent dans le formulaire.

Le règlement propose le solde restant, la date de réception et un libellé de moyen de paiement ; le montant, la date et les dépassements sont expliqués avant l'envoi. Les dates et notes d'une facture liée sont enregistrées avant de rejoindre son dossier. La consultation en lecture seule reste refermable.

Validation : 117 fichiers / 960 tests d'interface, TypeScript et compilation réussis. 24 parcours de récupération sur Edge/WebKit à 320/390/1440 px, 8 parcours de factures liées et 4 parcours de l'assistant de devis réussis. Les tests natifs de paire acompte/solde avec PDF et sauvegarde, de correction d'une facture payée et d'atomicité paiement/écriture comptable réussissent. L'intégration au dossier principal passe TypeScript, 161 tests ciblés et les 32 parcours de récupération/paire. Sauvegarde préalable : `.qa/sales-20260912-before/`. Les recettes navigateur sont synthétiques ; aucune installation ou publication nouvelle n'est attestée.
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

Les lots de paie et de reprise commerciale livrés précédemment sont publiés pour Windows en version 1.55.0, avec signature Tauri vérifiée, canal de mise à jour et page de téléchargement publics. Les lots achats/justificatifs et catalogue/coordonnées ajoutés ensuite ne sont pas encore distribués. L'IPA non signé reste en 1.53.0. Le présent audit n'atteste ni installation client, ni nouvelles versions macOS/Android. Voir RELEASE-WINDOWS-1.55.0.md pour les artefacts et preuves de la version publiée.

Le premier chargement contient encore un module `WorkspaceApp` d'environ 732 ko minifiés. Son découpage et les temps de réponse sur appareil mobile restent à examiner, en maintenant l'accès hors ligne aux fonctionnalités.

## Livraison Windows 1.55.0

Publication vérifiée le 12 septembre 2026 : installateur Windows 1.55.0, signature Tauri et empreinte disponibles sur GitHub et Supabase. Le fichier téléchargé publiquement correspond à l'artefact compilé et sa signature Ed25519 a été vérifiée. Le manifeste public `latest-windows.json` pointe vers cette version ; le canal partagé `latest.json` est inchangé et le manifeste Windows précédent est conservé.

La page de téléchargement publique est publiée via Sites, version 121. Le lien Windows, l'empreinte et le texte de présentation ont été relus dans le HTML public. Source binaire : `a303f0777828cbe698beaa054bbcaafa65dd4706` ; source du site : `4ce11f1d1d0a975631228fd6ccf7156e6301857b`. Détails : [RELEASE-WINDOWS-1.55.0.md](RELEASE-WINDOWS-1.55.0.md).

Cette publication ne constitue pas une validation sur un profil client réel. Authenticode reste indisponible. Aucun nouvel IPA ou paquet macOS/Android n'est inclus.
