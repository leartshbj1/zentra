# Exécution du scénario devis, acompte et rapprochement bancaire

Le 10 septembre 2026, le scénario `deposit_case` a été exécuté avec les commandes natives `LocalStore`, dans trois profils temporaires : parcours principal, restauration et cas bancaires à contrôler. Les données sont fictives. Le scénario n'insère pas directement les écritures comptables et n'utilise aucun compte bancaire ni profil client réel.

La source de départ est `8fa5994` ; l'empreinte du nouveau scénario et celle des attendus indépendants figurent dans `provenance.json`. Version déclarée 1.46.1, schéma natif 65 en préparation. Cette exécution concerne les sources locales, pas l'installateur public ni un appareil physique.

## Parcours principal

Entreprise fictive en CHF, TVA effective, contre-prestations convenues, périodicité trimestrielle. Un devis accepté du 5 janvier 2026 est lié à un projet. Sa conversion à 30 % crée deux factures distinctes dans le même dossier. La prestation fictive est prévue du 1er au 20 mars.

| Contrôle | Attendu et constaté, CHF |
| --- | ---: |
| Devis TTC | 1 081,00 |
| Facture d'acompte TTC | 324,30 |
| Facture de solde TTC, acompte déduit | 756,70 |
| TVA totale | 81,00 |

L'acompte est émis le 10 janvier et réglé le 15 janvier. La facture de solde est émise le 20 mars et réglée le 25 mars. Les deux numéros et références SCOR sont distincts et figés. Le PDF du solde contient la ligne négative de 300 CHF HT, les 24,30 CHF de TVA déduite dans ses calculs et le numéro de la facture d'acompte dans les remarques. Après le premier versement, seule la facture d'acompte est payée. Après le second, deux paiements soldent exactement les deux factures.

Les deux relevés CAMT sont synthétiques et contiennent les références réellement produites par l'application. Chaque fichier est réimporté : le même import est reconnu, sans paiement ni écriture supplémentaire. Une seconde conversion du devis est refusée et les données restent identiques.

Au premier trimestre, le résultat constate 1 000 CHF de chiffre d'affaires, la banque 1 081 CHF et le compte client zéro. La TVA à verser est de 81 CHF. Le journal comporte quatre écritures et dix lignes équilibrées. La pré-clôture ne relève aucune anomalie de continuité ; la période est effectivement clôturée et le ZIP natif est produit avec le statut `FINAL`.

## Avoir après clôture et restauration

Un avoir de 100 CHF HT, soit 108,10 CHF TTC, est émis le 10 avril contre la facture de solde. Il produit une écriture de trois lignes au deuxième trimestre et une TVA de -8,10 CHF. Le journal du premier trimestre reste identique. Le contenu de la facture initiale et son instantané figé restent identiques ; seule la métadonnée `updated_at` peut changer lors de l'actualisation de son état de paiement.

Les tentatives de modification et de suppression de la facture émise et d'une écriture clôturée sont refusées sans changement des données. Une sauvegarde native de format 2 conserve la base et le ZIP de clôture. Sa restauration dans un autre profil temporaire retrouve les données métier, le journal et les deux références figées, avec une chaîne d'audit valide et zéro anomalie de continuité. Aucun remboursement de cet avoir n'est exécuté dans ce scénario.

## Cas bancaires complémentaires

Ces cas utilisent un profil distinct et des montants techniques sans TVA ; ils ne valident pas une exonération fiscale réelle.

- Deux factures de 100 CHF et un paiement de 100 CHF sans référence : deux propositions sont présentées, aucune affectation automatique. La confirmation explicite d'une facture crée un paiement ; sa répétition conserve le même identifiant et les mêmes données.
- Une autre facture de 100 CHF reçoit 40 CHF puis 60 CHF avec sa référence : solde intermédiaire de 60 CHF, puis facture payée. Le rejeu de chaque fichier reste sans effet supplémentaire.
- Une facture de 100 CHF reçoit 120 CHF : le mouvement complet est conservé pour contrôle. Aucune affectation automatique n'a lieu et la confirmation directe est refusée. **L'affectation de 100 CHF et la création d'un crédit client de 20 CHF restent à implémenter et à vérifier.** Ce cas atteste la conservation du mouvement, pas un traitement complet du trop-perçu.

## Pièces et vérifications

Les sorties finales sont dans `output/pdf/recette-acompte-20260910-03/`. Le devis, les deux factures et l'avoir sont quatre PDF réellement générés par le moteur natif. Chaque page a été rendue et examinée. Les relevés XML sont des entrées synthétiques ; les reçus d'import permettent de vérifier leurs empreintes et leurs montants.

Le vérificateur indépendant `scripts/verify-fiduciary-deposit.py` contrôle les quatre attendus, les liens devis/projet/factures, les déductions, les références RF et leur MOD-97, les paiements et mouvements, les journaux, le contenu textuel des PDF et les empreintes des 19 membres du ZIP natif. Il ouvre en mémoire la base livrée dans la sauvegarde et compare les factures et paiements aux sorties. Il vérifie également que le ZIP de clôture sauvegardé est identique à celui livré séparément. `verification-artefacts.json` conserve le résultat.

Les essais natifs et Clippy GNU sur toutes les cibles passent, avertissements refusés. Aucun changement de règle comptable ni de code de rapprochement n'est livré avec ce scénario.

## Limites et travaux restants

1. **Acompte antérieur à la prestation :** le résultat de janvier contient déjà 300 CHF de chiffre d'affaires alors que la prestation est en mars. Cette observation est conservée dans `resultat-janvier-avant-prestation.json`. L'imputation temporelle et la présentation des avances reçues doivent être examinées et corrigées si nécessaire avant de valider ce cas professionnellement. L'égalité des totaux trimestriels ne suffit pas.
2. **Trop-perçus :** implémenter l'affectation partielle du mouvement et le crédit client, avec règlement ou remboursement, comptabilité, rejeu, sauvegarde et partage cohérents.
3. **Format bancaire :** les six fichiers sont acceptés par le parseur natif. Leur validation XSD n'a pas été obtenue : le téléchargement du [schéma ISO camt.053.001.08](https://www.iso20022.org/message/12736/download) a échoué. Aucune conformité complète ISO/SPS ni compatibilité avec une banque réelle n'est revendiquée. Les [instructions SIX pour le cash management](https://www.six-group.com/dam/download/banking-services/standardization/sps/ig-cash-management-sps-2025-de.pdf) restent la source de référence pour poursuivre cette vérification.
4. Exécuter la recette d'interface, les autres méthodes et cas TVA, les douze paies et le certificat annuel, puis obtenir la revue professionnelle. Ce dossier ne constitue ni une validation fiscale, ni une certification Swissdec, ni une preuve de synchronisation HTTPS ou de distribution sur plusieurs appareils.

## Reproduction

Choisir un chemin absolu inexistant pour `ZENTRA_DEPOSIT_OUTPUT`, afin de conserver les exécutions précédentes, et renseigner `ZENTRA_FIDUCIARY_SOURCE_REVISION` avec la source utilisée.

```text
cargo test --manifest-path desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-gnu fiduciary_deposit_acceptance::execute_deposit_and_bank_case_with_native_exports -- --ignored --nocapture
python scripts/verify-fiduciary-deposit.py CHEMIN_DU_DOSSIER
```

Les empreintes du scénario et de l'oracle utilisent des fins de ligne LF. Les fichiers natifs sont conservés sans transformation. Les chemins temporaires présents dans certains reçus identifient les exports d'origine ; leurs copies effectivement livrées se trouvent dans le dossier final ci-dessus.
