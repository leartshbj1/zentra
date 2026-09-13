# Paiement fournisseur guidé — 13 septembre 2026

Lot de la branche `codex/app-quality-20260912`, après la traduction du formulaire de facture fournisseur (`23449f8`). Il concerne le formulaire effectivement ouvert depuis Achats → Factures et avoirs et depuis une facture validée. Les paquets Windows/macOS 1.62.0 et l’IPA personnel 1.62.1 ne contiennent pas ce lot.

## Parcours et corrections

Le paiement se prépare en deux étapes : recopier ce qui a réellement été payé, puis vérifier le montant, la date, le mode, le compte utilisé et le reste à payer. Le formulaire accepte un règlement partiel et conserve la saisie décimale. La conversion en centimes utilise des entiers exacts, y compris près de la limite des entiers JavaScript. Les avoirs déjà déduits du solde sont indiqués. Le mode de paiement décrit le règlement ; il ne change pas le compte de liaison, affiché dans le résumé. Aucun ordre bancaire n’est transmis.

Les erreurs de montant ou de date rejoignent le champ concerné. Une facture absente, non validée ou sans solde ne peut pas être payée depuis un ancien exemplaire du formulaire. Un compte de paiement inactif, absent ou du mauvais type propose Plan & liaisons. Un refus pour exercice fermé propose l’écran des exercices et rappelle de corriger la date uniquement en cas de mauvaise saisie.

Le détour par la comptabilité garde le montant, la date, le mode, la référence, les notes et l’identifiant de la tentative. Un bouton permet de reprendre la saisie avec une nouvelle vérification. Fermer une saisie modifiée ou reprise demande confirmation. Remplacer un paiement déjà en attente de correction demande également confirmation. Cette conservation est en mémoire pendant la session de l’application ; elle ne constitue pas une sauvegarde après fermeture forcée ou redémarrage.

Une modification du solde, des avoirs, du document ou du compte dans les données chargées invalide le récapitulatif précédent. Le serveur conserve ses contrôles de solde, de période ouverte, de comptes actifs et d’idempotence. Ce lot n’ajoute pas de verrou transactionnel du compte affiché lors de la revue : un changement concurrent de configuration est soumis aux contrôles existants du serveur.

## Réponse interrompue

Le pont natif distingue désormais une commande sans réponse d’une commande acquittée suivie d’une lecture interrompue. Dans les deux cas, la reprise lit l’historique et ne renvoie pas la commande. Elle compare l’identifiant de tentative, la facture, le montant, la date, le mode, la référence, les notes et la présence du lien comptable. Des données incomplètes, une facture manquante, un identifiant retrouvé avec un contenu différent ou un lien comptable manquant maintiennent la vérification ouverte.

Un refus confirmé par une lecture complète rend la main au formulaire pour correction. Une écriture retrouvée met à jour le dossier sans nouveau paiement. Les champs et la fermeture sont bloqués pendant l’opération et la reprise. Le formulaire dispose d’un verrou immédiat contre les doubles soumissions, en complément du verrou commun et de l’idempotence native.

## Langues et présentation

Le paiement, les explications des corrections, les actions de reprise et la fenêtre commune de vérification après réponse interrompue disposent des quatre langues FR/DE/IT/EN. Les textes de l’utilisateur et les noms des comptes restent inchangés. Les messages techniques originaux sont conservés dans un détail déroulant. Les autres listes, consultations et actions des achats restent à compléter ; ce lot ne déclare pas leur traduction terminée.

Le récapitulatif met les montants et le compte avant la référence et les notes longues. Les commandes restent accessibles en bas de la fenêtre, et le défilement place le champ actif au-dessus de ces commandes. Les actions font au moins 44 px de hauteur. Les transitions respectent la préférence de mouvement réduit.

## Preuves

- 1 502 tests UI réussis dans 178 fichiers. Sept nouveaux tests couvrent les centimes exacts, les corrections, l’invalidation de la revue, l’identité complète du paiement, les données incomplètes et la reprise sans écriture supplémentaire.
- 32 parcours de paiement, Edge et WebKit, quatre langues, aux dimensions 320×568, 390×844, 844×390 et 1440×1000. Les essais couvrent le focus des erreurs, la langue en cours de saisie, le détour par la comptabilité, le solde modifié et les avoirs, la lecture seule, les doubles soumissions et la réponse perdue avec lectures temporairement bloquées. Les valeurs finales et le nombre de paiements sont vérifiés, ainsi que le maintien des notes au-dessus du pied de formulaire et l’abandon refusé après reprise.
- Six parcours de régression Edge/WebKit couvrent le brouillon, le justificatif, la validation, un paiement partiel puis le solde, avec refus et interruption de lecture.
- Neuf tests SQLite natifs réussis : cycle et idempotence de la facture fournisseur, périodes closes, prix, références, coûts de projet et TVA des achats non déductibles. Le moteur Rust et le schéma n’ont pas été modifiés.
- Compilation TypeScript/Vite réussie. L’avertissement préexistant sur la taille de certains modules reste présent.

Les parcours navigateur utilisent des données synthétiques et une persistance simulée. Ils ne prouvent pas l’exécution sur un iPhone physique ni l’installation d’une nouvelle version.

Preuves locales : `.qa/supplier-payment-all-ui.log`, `.qa/supplier-payment-chromium/report.json`, `.qa/supplier-payment-webkit/report.json`, `.qa/supplier-payment-lifecycle.log`, `.qa/supplier-payment-native.log`, `.qa/supplier-payment-build.log`.
