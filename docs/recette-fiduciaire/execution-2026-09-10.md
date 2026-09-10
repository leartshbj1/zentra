# Exécution du scénario TVA, avoirs et comptes annuels

Le 10 septembre 2026, le scénario `ledger_case` a été exécuté dans un profil SQLite temporaire, via les mêmes commandes `LocalStore` que l’application. Aucune écriture comptable n’est insérée directement par le scénario. Les attendus du 8 septembre sont conservés sans modification.

La source métier de référence est `2528620004442a90adff35d6105767616d3c99c6` ; le scénario ajouté est identifié par son empreinte dans `provenance.json`. Version déclarée 1.46.1, schéma natif 65 en préparation. Ce n’est pas un essai de l’installateur public 1.46.1, qui contient un autre état de source.

## Opérations exécutées

Profil entièrement fictif en CHF, TVA effective, contre-prestations convenues, périodicité trimestrielle. Apport bancaire initial de 10 000 CHF, vente de 1 000 CHF HT payée, achat de marchandises consommées de 400 CHF HT payé, avoir client de 100 CHF HT remboursé, avoir fournisseur de 50 CHF HT remboursé. Les opérations sont datées de janvier 2026, au taux de recette de 8,1 %. Le compte 4000 est créé et associé aux achats avant toute écriture ; les comptes existants restent protégés.

Le justificatif fournisseur de deux pages est un **document d’entrée synthétique**, créé séparément avec ReportLab. Ses octets sont importés par la commande ordinaire d’ajout de pièce jointe. La facture client, l’avoir client et les comptes annuels sont, eux, de **véritables sorties du moteur PDF natif**. Aucun document ne représente une opération réelle.

## Comparaison constatée

| Contrôle | Attendu et constaté, CHF |
| --- | ---: |
| Chiffre d’affaires net | 900,00 |
| Achats nets de marchandises | 350,00 |
| TVA due après avoir | 72,90 |
| TVA préalable après avoir fournisseur | 28,35 |
| TVA à verser | 44,55 |
| Résultat avant impôts | 550,00 |
| Banque | 10 594,55 |
| Actifs, TVA non compensée | 10 622,90 |
| Passifs et fonds propres, résultat compris | 10 622,90 |

Les créances clients et dettes fournisseurs sont à zéro. Le paiement répété conserve le même identifiant et la même écriture : neuf écritures et 22 lignes sont présentes. Le contrôle de continuité ne relève aucune anomalie. Chaque écriture est équilibrée. La pré-clôture conserve un justificatif vérifié ; le dossier reste **DRAFT**, exercice non clôturé.

## Pièces et vérifications

Les fichiers sont conservés dans `output/pdf/recette-fiduciaire-20260910-05/` : données métier fictives, configuration, journal, grands livres, balance, bilan, résultat, comparaison, reçus des commandes, XML, PDF et ZIP natif. Le ZIP natif contient l’index des pièces ; le justificatif original est également livré séparément dans le dossier d’exécution.

- Exécution native finale : un scénario réussi, 2,67 s ; compilation GNU réussie. L’essai est explicitement ignoré dans la suite ordinaire car il écrit un dossier d’artefacts demandé.
- Vérificateur Python séparé : comparaison des neuf valeurs avec l’oracle, identifiants et champs du journal, équilibre par écriture, PDF natifs, original du justificatif et empreintes des 21 membres du ZIP vérifiés.
- XML final validé contre les dix schémas eCH importés depuis les adresses officielles ; empreintes des schémas et du XML conservées dans `validation-xsd.json`.
- Six pages rendues et examinées : facture, avoir, bilan, résultat et deux pages de justificatifs fictifs. Aucun texte coupé ni chevauchement constaté.
- Clippy GNU sur toutes les cibles, avertissements refusés : réussi, 18,60 s.

Les sources AFC consultées confirment le [taux normal de 8,1 %](https://www.estv.admin.ch/fr/taux-de-la-tva-suisse) et expliquent la [déduction de l’impôt préalable pour l’activité imposable](https://www.estv.admin.ch/fr/taxe-sur-la-valeur-ajoutee). Cette recette ne valide pas l’assujettissement ni le droit à déduction d’une entreprise réelle. Le XML n’a pas été transmis à l’AFC.

## Reproduction

Avec les dépendances natives du projet installées, choisir un chemin absolu **inexistant** pour `ZENTRA_FIDUCIARY_OUTPUT`, puis lancer :

```text
cargo test --manifest-path desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-gnu fiduciary_acceptance::execute_ledger_case_with_native_exports -- --ignored --nocapture
python scripts/verify-fiduciary-execution.py CHEMIN_DU_DOSSIER
python desktop/tests/validate-vat-xml.py CHEMIN_DU_DOSSIER/tva-2026-T1.xml CHEMIN_DU_CACHE_XSD
```

Le test refuse de remplacer un dossier précédent et n’ouvre jamais le profil de l’utilisateur. `ZENTRA_FIDUCIARY_SOURCE_REVISION` permet de consigner le commit testé. Les empreintes de l’oracle et du scénario sont calculées sur le texte avec fins de lignes LF pour être vérifiables sur plusieurs systèmes.

## À poursuivre

Exécution dédiée du dossier devis/acompte/solde avec import bancaire et rejeu ; douze paies et certificat annuel ; autres méthodes et situations TVA ; revue par une fiduciaire ; recette de l’interface et des installations réelles. Aucune validation professionnelle, certification Swissdec, nouvelle publication ou synchronisation HTTPS à deux comptes n’est attestée par ce scénario.
