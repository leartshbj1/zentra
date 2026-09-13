# Consultation des factures fournisseurs — 13 septembre 2026

Lot de `codex/app-quality-20260912`, après le paiement guidé (`fa55d7e`). Il remplace la consultation réellement ouverte depuis les cartes des achats et l’agenda. Il ne modifie pas le moteur comptable, le schéma ni les montants enregistrés. Les paquets distribués Windows/macOS 1.62.0 et l’IPA personnel 1.62.1 ne contiennent pas ce lot.

## Comprendre le solde

Le résumé présente d’abord le reste à payer, puis les quatre montants : total de la facture, paiements, avoirs déduits, solde. Une facture entièrement compensée par des avoirs est appelée « soldée » ; l’écran n’affirme pas que son total a été envoyé au fournisseur. L’explication distingue également un brouillon, une échéance dépassée et une facture encore à régler.

La consultation retrouve le document dans les données actuelles. Elle ne réutilise plus silencieusement un ancien exemplaire si la facture disparaît du workspace. Les montants canoniques sont conservés tels quels ; des additions entières vérifient la cohérence du solde et la présence de son historique. Une incohérence ou un historique incomplet produit une explication et un bouton d’actualisation, sans proposer de nouveau paiement depuis cet écran. Un échec de lecture conserve la consultation et permet de réessayer. Le bouton de paiement mène au formulaire guidé avec le solde courant ; il est désactivé en lecture seule.

## Documents et historique

Trois onglets séparent le résumé, les documents et l’historique. Le clavier permet de passer d’un onglet à l’autre avec les flèches, Début et Fin. Chaque onglet référence son panneau ; seul le panneau actif affiche son contenu.

Les justificatifs sont suivis des lignes de la facture sous forme de blocs lisibles sur mobile. Les montants HT, TVA et TTC restent ceux du document enregistré. Les lignes et événements longs s’affichent par groupes de 20, avec un bouton pour poursuivre. Les informations ne sont pas supprimées ni limitées dans la base.

L’historique réunit paiements, utilisations d’avoirs et annulations d’utilisation. Il classe les opérations par leur date effective décroissante ; les dates de création servent uniquement à départager deux événements du même jour. Les événements sans date effective connue apparaissent après les événements datés, avec la mention explicite de la date manquante. Une date de création ne remplace pas une date de compensation absente. Les avoirs liés à d’autres factures sont exclus de cet historique.

Une utilisation d’avoir indique qu’elle réduit la dette ; son annulation indique qu’elle rétablit le montant à payer. Un bouton ouvre l’avoir lié dans les achats. Un bandeau permet ensuite de revenir directement à l’historique de la facture.

## Présentation et langues

Les libellés, explications, avertissements et actions de cette consultation sont disponibles en français, allemand, italien et anglais. Les noms, références, descriptions, notes et modes de paiement personnalisés restent inchangés. Les notes conservent leurs retours à la ligne. Les erreurs techniques originales restent disponibles dans un détail déroulant.

Sur petit écran, l’en-tête utilise une référence courte plutôt qu’une description répétitive. Une référence très longue est limitée à deux lignes dans l’en-tête et reste visible en entier dans le résumé. Le contenu défile indépendamment des commandes de fermeture et de paiement. Les actions font au moins 44 px ; les montants restent distincts des libellés longs. Les transitions respectent la préférence de mouvement réduit.

Ce lot ne déclare pas les autres listes et formulaires des achats entièrement traduits. Il ne prouve pas l’utilisation sur un iPhone physique et n’a pas été publié dans un nouvel installateur.

## Vérification

- 1 507 tests UI réussis dans 179 fichiers. Cinq nouveaux cas couvrent l’ordre des dates, les dates manquantes, les avoirs nets après annulation, une facture soldée sans paiement, l’historique incomplet, les montants incohérents et la couverture de traduction. Les cinq cas ciblés sont aussi rejoués après l’ajustement de la donnée de test d’une compensation intégrale.
- 32 parcours Edge/WebKit aux dimensions 320×568, 390×844, 844×390 et 1440×1000 dans les quatre langues. Ils vérifient les montants affichés, la conservation des notes et libellés personnels, l’ordre de l’historique, les onglets au clavier, la lecture seule, l’ouverture des justificatifs, l’aller-retour vers l’avoir, les lectures interrompues, le passage au formulaire de paiement, les dossiers longs et la disparition de la facture. Aucune commande de paiement n’est envoyée par ces parcours de consultation.
- Les huit parcours allemands sont rejoués après correction du terme générique « Documents » en « Dokumente ».
- Compilation TypeScript/Vite réussie. L’avertissement préexistant sur la taille de certains modules subsiste.

Les parcours navigateur utilisent des données synthétiques et une persistance simulée. Aucun nouvel impôt, taux, arrondi comptable ou traitement de paiement n’est ajouté ; les garanties SQLite du moteur sont celles vérifiées dans le lot précédent.

Preuves locales : `.qa/supplier-detail-all-ui.log`, `.qa/supplier-detail-unit-final.log`, `.qa/supplier-detail-build.log`, `.qa/supplier-detail-chromium/report-four-languages.json`, `.qa/supplier-detail-webkit/report-four-languages.json`, `.qa/supplier-detail-chromium-german-final.log` et `.qa/supplier-detail-webkit-german-final.log`.
