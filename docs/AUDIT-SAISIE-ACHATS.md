# Saisie guidée des factures fournisseurs — 13 septembre 2026

Travail dans `codex/app-quality-20260912`, postérieur aux paquets publics Windows/macOS 1.62.0 et à l’IPA personnel 1.62.1. Ce lot n’est pas encore distribué. Le moteur comptable et le schéma de données ne changent pas.

## Parcours

Le grand formulaire est remplacé par quatre étapes : fournisseur et dates, achats, vérification des montants, puis justificatif. Le total reste visible dans le résumé. L’utilisateur compare le récapitulatif avec son original avant d’enregistrer le brouillon. La validation comptable et le paiement restent des actions distinctes.

Le formulaire ne choisit plus arbitrairement le premier fournisseur lorsqu’il existe plusieurs choix. Le délai habituel suit un changement de fournisseur ou de date tant que l’échéance n’a pas été personnalisée. Un bouton permet de reprendre explicitement ce délai. Les notes gardent leurs retours à la ligne.

Les valeurs monétaires et quantités restent sous forme de texte pendant la saisie. Une précision excessive, un prix manquant ou un format incorrect n’est plus arrondi silencieusement. Le message explique quoi recopier et donne un exemple ; le focus rejoint le champ concerné, y compris dans les options de remise. Les calculs utilisent des entiers exacts avec le même ordre d’arrondi que le moteur natif.

La fermeture demande de confirmer l’abandon des modifications non enregistrées. Les étapes et boutons sont protégés pendant un enregistrement ou le choix d’un fichier. Un retour en lecture seule pendant ce choix empêche l’ajout. Une reprise après une erreur de lecture recharge les données sans répéter l’écriture déjà confirmée. Les identifiants du brouillon et des lignes restent stables.

## Présentation

La fenêtre utilise une zone de défilement interne sur ordinateur comme sur téléphone : les commandes restent accessibles et ne recouvrent plus la note active. Les transitions courtes respectent la préférence de mouvement réduit. Les actions ont une hauteur minimale de 44 px, les noms des justificatifs sont agrandis et les empreintes techniques sont retirées de leur présentation courante. Les contrôles d’intégrité du stockage restent en place.

## Vérification

- Tests UI complets : 1 491 réussis, dont huit cas de préparation des achats. Compilation TypeScript/Vite réussie.
- Huit parcours de préparation Edge/WebKit à 320×568, 390×844, 844×390 et 1440×1000 : fournisseur explicite, décimales, échéance personnalisée, focus des erreurs, notes, fermeture, lecture seule, double soumission, ajout du justificatif et reprise sans doublon. Contrôles de débordement et captures inspectées.
- Huit parcours de validation fournisseur : correction de référence depuis la revue, retour aux justificatifs, liens vers comptes/exercices/rapprochement et reprise de validation. Les tests existants ont été adaptés aux étapes du nouveau formulaire.
- Six parcours couvrent le brouillon, le justificatif, la validation, un paiement partiel puis le solde, avec refus et réponse interrompue.
- Cinq parcours d’achats d’une entreprise non assujettie conservent les montants HT, TVA et TTC sur commandes, factures et avoirs. Aucun nouveau taux ou traitement fiscal n’est introduit.
- Tests SQLite réels : cycle facture/paiement, protections des périodes closes, prix rapprochés, références, coûts de projet et traitement des achats non déductibles. Le test de classement TVA vérifie l’annulation complète après un échec puis une reprise sans doublon. Un cas complémentaire vérifie les décimales, les remises, les arrondis par ligne, les notes et l’absence d’écriture comptable lors de la sauvegarde du brouillon.

Les parcours navigateur utilisent des données synthétiques et une persistance simulée ; les garanties de stockage sont couvertes séparément par les tests SQLite. Ils ne prouvent pas l’utilisation sur un appareil iPhone physique. Ce nouveau parcours reste en français ; sa traduction et celle des autres écrans métier restent à compléter. Les modifications non enregistrées ne sont pas récupérées après une fermeture forcée de l’application.

Preuves locales : `.qa/supplier-preparation-all-ui.log`, `.qa/supplier-preparation-build.log`, `.qa/supplier-preparation-native.log`, `.qa/supplier-preparation-native-vat.log`, `.qa/supplier-preparation-chromium/report.json`, `.qa/supplier-preparation-webkit/report.json`, `.qa/supplier-preparation-review.log`, `.qa/supplier-preparation-lifecycle-final.log`, `.qa/supplier-preparation-non-registered.log`.
