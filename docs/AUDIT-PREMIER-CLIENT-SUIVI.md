# Préparation du premier client — suivi du 27 septembre 2026

Objectif : traiter les vingt points de l’audit, avec des preuves adaptées. Aucun statut global « prêt » n’est déduit d’un build ou de tests simulés.

Audit : `C:/Users/alb/Documents/ChatGPT/chantier/outputs/audit-premier-client-20260927/AUDIT.md`. Les captures de référence utilisent l’interface réelle et une entreprise fictive ; elles ne sont pas une recette des appareils installés.

| # | Travail et état actuel | Preuve nécessaire pour fermer le point |
|---|---|---|
| 1 | HTTP 500 de synchronisation : diagnostic structurel publié (source `3125e26e`, Sites 272). Cause précise encore à isoler. Sans trafic de collaboration, l’absence de nouvelle erreur ne prouve pas une résolution. | Deux comptes/installations réels : devis, facture, encaissement, remboursement, soldes identiques, coupure et reprise sans doublons. |
| 2 | Diagnostics serveur publiés, cycles et échecs partiels instrumentés (Sites 273), sans contenu métier ni secret. Complété localement : dernière vérification distincte du dernier échange, retard après 90 s sans succès, erreur conservant l’heure et changement d’entreprise la réinitialisant ; minuteur partagé entre barre et panneau. | 25 tests et huit parcours navigateur passés, revue `ship` sur ce lot. TypeScript/build Vite final réussis ; distribuer le binaire et corréler un échec réel. |
| 3 | Automation autonome : GitHub précédemment bloqué par facturation ; SQL Supabase disponible mais application non démontrée. `SUPPORT_MAIL_BACKGROUND_ENABLED` absent à la révision 36. | Observer un travail planifié sans application ouverte, ses reprises, limites et idempotence. |
| 4 | Artefacts 1.90.2 publiés précédemment ; macOS ad hoc/non notarisé, IPA non signé, APK avec certificat de test existant. Windows local encore 1.90.0 à l’audit. | Signature et distribution adaptées, installations/mises à jour réelles des quatre plateformes, données conservées. |
| 5 | Parcours premier client complet à réaliser ; les tests isolés ne suffisent pas. | Inscription extérieure, e-mail reçu, récupération, Stripe en mode test, droits, invitation, second appareil, sauvegarde/restauration. |
| 6 | Corrigé localement : consultation des trois formulaires de base des paramètres sans bloquer la réception. Réception recréant leurs valeurs tout en gardant la rubrique. Toute saisie, même dans une rubrique ensuite cachée, protège le brouillon jusqu’à quitter les paramètres. Statut d’attente distinct du transfert. | Parcours Chromium/WebKit passés ; binaire et vérification réelle à terminer. Les autres éditeurs restent protégés. |
| 7 | Agenda corrigé localement : Jour initial sur téléphone, rendez-vous avant les compteurs. Achats : recherche et réception réunies. Devis/factures à 860 px et moins : recherche, filtres et outils Automation repliables, nombre/ordre et montant prioritaires ; 48 parcours passés. | Support reste à traiter ; terminer la recette sur appareils installés. Les preuves navigateur ne clôturent pas tout le point. |
| 8 | Corrigé localement : assistant réservé dans la barre d’outils au lieu de recouvrir le contenu ; aide des modales conservée. | Ouverture vérifiée en navigateur ; recette binaire à terminer. |
| 9 | Corrigé localement : compteur commun dédoublonné, indisponibilité distincte de zéro, recherche partagée, brouillon distinct de comptabilisé. Résultat de lot et exceptions explicites ; aucun « tout à jour » quand des brouillons restent à valider. | Comptages reçus/à vérifier/comptabilisés cohérents et vérification de lot avec exceptions. |
| 10 | Implémenté dans le périmètre factures/workflows : journal natif avec métadonnées, montant extrait, état réel et ouverture exacte ; absence locale et activité inconnue explicites. Backend publié Sites 275, métadonnées récentes bornées séparées des compteurs du jour. Aucune économie inventée. | Revue `ship` sur ce lot ; nouveau binaire natif à livrer, puis recette authentifiée avec e-mails et documents réels. Ne pas étendre cette preuve à tous les automatismes. |
| 11 | Démarrage et sélection des espaces à clarifier. | Même compte sur deux appareils avec des données ; choix explicite et aucun mélange d’entreprises. |
| 12 | Amélioré localement : identité et logo avant NOGA, descriptif « Salariés et fiches de paie », boutons « Configurer la comptabilité ». Parcours existants revérifiés sans code nouveau : 12 boucles accidents, trois corrections LPP et 104 tests Rust réussis. | Distinction complète salariés/membres et recette native avec contrats réels restent à vérifier ; aucun taux contractuel deviné, aucune certification réglementaire déduite. |
| 13 | Corrigé localement : messagerie, variables, modèles, aperçus, erreurs connues et états en FR/DE/IT/EN ; contenu client inchangé. Libellés visibles des listes, navigation et filtres Devis/Factures vérifiés dans les quatre langues. | Traduction exhaustive des éditeurs/actions Ventes et messages inconnus non démontrée ; publier le binaire. |
| 14 | Corrigé localement : onglets/variables e-mail 44 px minimum ; rubrique révélée sous la barre fixe. Ventes mobile : recherche et bouton de filtres ≥ 44 px en CSS, Échap conserve la saisie et rend le focus, bordures par cellule supprimées. | Poursuivre les autres écrans et la recette d’accessibilité ; aucun résultat global de conformité n’est annoncé. |
| 15 | Taille du texte à ajouter sans zoom global ni suppression du zoom des documents. | Taille 200 %, redistribution mobile et clavier. |
| 16 | Clarifié localement : cumul toutes années, reste dû toutes années et CA annuel hors TVA explicitement séparés ; devises conservées. Aucune facture émise : CA affiché —. États vides des autres menus encore à traiter. | Stock/flux distingués, prochaine action unique, aucun faux zéro comptable. |
| 17 | Secret SMTP par appareil et modèles par entreprise indiqués et traduits. Acceptation SMTP distincte de la livraison. | Stratégie partagée/OAuth, droits, erreurs et recette de livraison ; aucun secret synchronisé en clair. |
| 18 | Synthèse financière extraite et configuration initiale chargée seulement si nécessaire. Graphe JS statique initial : 1 611 943 → 1 427 494 octets (−11,4 % brut ; −7,2 % gzip par fichier). Huit parcours de démarrage passés, compte distant retardé de dix secondes. Pas une mesure de démarrage natif ni de serveur. | Navigation, mémoire, chargement des langues, CSS inutilisé prouvé et absence de régression. |
| 19 | Sites 274 publié, source dc4de922 : nonce par réponse HTML privée, CSP en observation, HSTS un jour. CSP appliquée existante inchangée. Contrôle public passé ; aucune recette authentifiée/Stripe/Safari implicite. | Observation compatible Vinext puis politique appliquée et parcours authentifiés/Stripe vérifiés. |
| 20 | Corrigé localement : texte `.zentra` et checklist actualisés. Tests Rust exécutés : 19 réussis, un test HTTPS réel ignoré explicitement ; restauration base/pièces, refus des anciennes archives, intégrité, retour arrière sur échec et licence locale. | Inclure ces textes dans la prochaine livraison ; recette via interface et deux installations réelles encore à exécuter. |

## Preuves du lot d’interface

- `desktop/.qa/first-client-interface/proof.json` : 28 parcours Chromium/Edge et WebKit, 320/390/1440 px, FR/DE/IT/EN. Aucune transmission SMTP réelle.
- `desktop/.qa/company1711/proof.json` : quatre parcours de synchronisation simulée, émission/encaissement, 2,77 à 2,95 s, écran visible et saisies préservées. Ce délai n’est pas une mesure de production.
- `desktop/tests/outgoing-mail-journey.mjs` : quatre parcours de connexion simulée, contrat IPC strict, mot de passe conservé, double clic sans double envoi, erreur incertaine sans renvoi automatique.
- 38 tests unitaires ciblés réussis, puis 18 tests affectés et compilation web/TypeScript repassés après les dernières corrections. Revue Impeccable : correction du message d’attente résolue, disposition `ship` limitée à cette correction ; documentation dans `INTERFACE-PREMIER-CLIENT-20260927.md`. Intégration aux binaires encore en attente.
- `desktop/.qa/first-client-interface/settings-review-proof.json` : quatre reprises après sauvegarde partielle, détail d’attente visible dans le panneau Compte, protection du brouillon caché et réception après sortie des paramètres. Aucune sauvegarde automatique du brouillon n’est impliquée.

## Limites d’accès constatées

Le contrôle navigateur échoue à l’initialisation avec `failed to write kernel assets` (chemin introuvable). Aucun accès administrateur Supabase n’a été rétabli par ce moyen. Les secrets serveur sont masqués par l’API Sites et ne sont pas reconstitués. Les corrections locales, tests simulés et diagnostics structurels restent possibles.

## Fraîcheur de synchronisation — lot local

- `desktop/.qa/company-sync-health/proof.json` : huit parcours Edge/WebKit, par moteur 320 px DE sombre, 390 px FR clair, 390 px IT sombre, 1440 px EN clair. Dernier contrôle distinct du dernier échange, heure conservée après échec, retard cohérent barre/panneau, reprise automatique et changement d’entreprise ; états et horloge simulés.
- 25 tests `companySyncPresentation`, `companyRealtime`, `projectSyncScheduler`, `workspacePersonalizationLanguage` réussis. Revue `ship` limitée à ce lot ; détecteur avec trois avis préexistants inchangés. Aucun changement de DESIGN. TypeScript et build Vite final après typage numérique du minuteur réussis.
- Résultat Rust indépendant communiqué : `cargo test --locked --lib company -- --test-threads=2` — 38 réussis, un diagnostic d’archive explicitement ignoré, 86,36 s. Deux copies SQLite locales, émissions/paiements, conflits et changement d’entreprise couverts. Ce résultat n’est ni une recette HTTPS de production ni une preuve de résolution du HTTP 500 ; aucun nouveau binaire n’est distribué.

## Agenda et factures fournisseurs — lot local suivant

- Agenda : 32 combinaisons Edge/WebKit, 320/390/844/1440 px, quatre langues ; huit parcours guidés de modification, reprise après erreur et conservation du brouillon en sessionStorage. Preuves : `desktop/.qa/agenda-mobile-focus/proof.json`, `desktop/.qa/agenda-guided-chromium/report.json`, `desktop/.qa/agenda-guided-webkit/report.json`.
- Achats : six parcours de réception, recherche et récupération après indisponibilité ; 16 vérifications de lot (12 brouillons ou 10 brouillons et deux exceptions), quatre langues, Edge/WebKit. Preuves : `desktop/.qa/purchase-inbox-clarity/proof.json`, `desktop/.qa/purchase-inbox-batch-result/proof.json`. Interface et moteur JavaScript réels, données et IPC fictifs.
- 48 tests unitaires ciblés réussis ; TypeScript et build Vite repassés après nettoyage. Deux revues Impeccable terminées avec leurs corrections ; documentation INTERFACE mise à jour. Ces modifications ne sont pas encore distribuées dans un nouveau binaire.

## Publications serveur et site

- Sites 273 : source 47986d8b, journalisation des cycles et erreurs partielles des boîtes et workflows. Pas de preuve de déclenchement planifié sans application.
- Sites 274 : source dc4de922, déploiement appgdep_6ab86858780c81918a82eb6c7a37a83e réussi le 27 septembre à 00:50 UTC. Contrôle en ligne /connexion, /mot-de-passe, /support/demo et /download : HTTP 200, HSTS présent, aucun incident JavaScript/CSP observé. Pages privées anonymes avec nonce ; aucun test de session réelle ou paiement.
- Journaux d’erreurs sur les 60 minutes consultées après publication de Sites 274 : aucun événement retourné. Sans trafic de collaboration confirmé, cela ne clôt pas le défaut HTTP 500 de l’audit.
- Sites 275 : source exacte `c0bda0ecc23acd98a4a55e5782dc894dfc36730a`, déploiement `appgdep_6ab877f91c8c81919120f3f58694941c` réussi le `2026-09-27T01:57:35Z`, environnement révision 36. Sur `zentraapp.ch`, `/connexion` et `/compte/automation` anonymes : HTTP 200 et HSTS ; GET de l’ordonnanceur : 405. Ces contrôles communiqués ne prouvent ni session authentifiée ni exécution planifiée.
- Lecture seule D1 de production : zéro transfert, conflit et commit retourné dans le périmètre consulté ; les erreurs récentes examinées ne contiennent que des 404/405. Sans trafic de collaboration probant, ces observations ne prouvent pas la réparation du HTTP 500.

## Activité Automation — interface locale et serveur publié

- Journal natif : fournisseur, référence, montant extrait/devise, e-mail source et fichier dans les détails ; ouverture de l’identifiant exact. Si la facture manque localement, message factuel traduit et renvoi vers Achats, sans promesse de synchronisation. États `review`/`needs_review` cohérents, activité inconnue sans faux état rassurant, jour du serveur et dates/fuseaux invalides traités.
- `desktop/.qa/automation-activity-clarity/proof.json` : 24 cas Edge/WebKit × 320/390/1440 px × quatre langues. `desktop/.qa/automation-activity-review-fix/proof.json` : huit reprises à 320 px, deux moteurs et quatre langues, avec navigation entière sur une ligne et absence locale explicite. Données fictives ; 32 tests unitaires, TypeScript et Vite réussis, revue `ship` limitée au lot. Détecteur : 12 avis préexistants de rayons/tailles de texte, sans nouvel avis.
- Backend Sites 275 : métadonnées de réceptions/imports récents bornées à 20 et indépendantes des compteurs quotidiens ; pas de texte intégral, données bancaires ou secrets. Anciennes extractions malformées rendues nulles sans échec de réponse. 18 tests puis 67, dont 14 en commun, sur données de service/SQLite fictives ; TypeScript et build backend réussis.
- Nouveau binaire natif toujours en attente. Aucune recette de session réelle, réception d’e-mail externe ou exécution autonome de production déduite de ce lot.

## Listes Ventes sur téléphone

- `desktop/.qa/sales-mobile-focus/proof.json` : 48 cas Edge/WebKit × 320/390/1440 px × FR/DE/IT/EN × Devis/Factures. À 860 px et moins : recherche partagée, filtres et outils Automation repliables ; recherche/focus conservés après Échap, tri et filtres vérifiés. L’état sans documents conserve les outils dans le code relu, hors matrice navigateur.
- 14 tests Ventes et 10 tests langue/copie réussis ; TypeScript et build Vite passés. `outputs/first-client-sales-mobile-detector.json` vide ; revue `ship` sur ce lot uniquement. Données fictives, aucun nouveau binaire livré.

## Paie — validation fraîche sans modification de code

- `desktop/.qa/payroll-accident-loop/report.json` : 12 parcours Edge/WebKit × 320/1440 px × assurance manquante/nouvelle cotisation/doublons ; une AAP retenue et aucune écriture doublonnée. `desktop/.qa/payroll-pension-corrections/report.json` : trois parcours Edge à 320/390/1440 px, correction LPP ciblée, saisie et salaire conservés, calcul et enregistrement. IPC navigateur simulé.
- `cargo test --locked --lib payroll -- --test-threads=2` : 104 tests réussis sur de vrais magasins temporaires Rust, indépendamment des parcours navigateur. Aucune certification réglementaire, validation de contrats client ou recette native réelle déduite.

## Clarté de l’accueil et des réglages

- `desktop/.qa/first-client-clarity/proof.json` : 24 variantes Edge/WebKit, quatre langues, 320/390/1440 px ; six vérifications des réglages en français. Révision finale revue : ship sur ce lot uniquement.
- `desktop/.qa/bank-guided/report.json` : huit parcours banque avec préservation des saisies, refus, correction des comptes, double clic, doublons et lecture seule ; IPC fictif.
- 46 tests ciblés finances/workflows/langue, puis 10 tests langue/couverture ; TypeScript et build Vite réussis. Aucune règle comptable ou taux modifié.
- Mesure `desktop/.qa/runtime-speed/first-client-1500.json` ; empreinte de résultat identique sur trois exécutions. Le gain de performance n’est pas inféré d’une extraction de fichier.

## Démarrage et restauration

- `desktop/.qa/startup-lazy/proof.json` : huit parcours Edge/WebKit, 390/1440 px, configuration nouvelle ou entreprise existante. Le compte distant simulé dure dix secondes ; l’espace local s’affiche entre 452 et 590 ms après installation de la fixture. Une seule vérification de compte, aucun téléchargement du guide pour l’entreprise déjà configurée. Mesure Vite locale, pas une promesse sur appareil réel.
- `desktop/.qa/runtime-speed/entry-before.json` et `entry-after.json` : graphe d’imports statiques construit depuis le HTML et les fichiers de production, imports dynamiques exclus. 184 449 octets JS bruts en moins ; aucun gain CSS annoncé.
- 32 tests ciblés ouverture/compte/configuration ; TypeScript et Vite réussis. Revue limitée au démarrage et au fond de connexion : ship. Aucune nouvelle étape de connexion ni autorisation changée.
- `cargo test --locked --lib backup::tests -- --test-threads=2` exécuté sur Windows : 19 réussis, zéro échec, un test cloud HTTPS réel ignoré ; 20,03 s d’exécution après compilation. Données temporaires uniquement. Le format courant revient correctement avec ses pièces et les archives invalides ne remplacent pas les données actives.
