# Zentra 1.90.8 — compilation en cours, non publiée

29 septembre 2026. La version native actuellement publiée reste **1.90.7**. Ce document décrit la source préparée pour 1.90.8 ; aucun paquet, signature, installation ou publication de cette version n’est attesté à ce stade.

## Contenu préparé

- Accueil : les raccourcis de création choisis suivent le résumé financier. Les factures à régler sont triées par échéance et chaque ligne ouvre la facture choisie.
- Téléphone : montants, actions et navigation de l’accueil adaptés au texte agrandi ; rubriques de suivi traduites en français, allemand, italien et anglais.
- Historique financier : index temporaires pour éviter les recherches répétées lors de la normalisation des relations entre documents. Montants, ordre source et liens existants conservés, sans cache partagé entre entreprises. Voir [la mesure et ses limites](NORMALISATION-HISTORIQUE-FINANCIER-20260929.md).

Les changements applicatifs préparés sont documentés par `55152c8b9279a13d693c76bff2bb4b0a1308dfff` (normalisation) et `1a4767f0838913e8f4a09fe4bb3b3df9c260fbcb` (accueil). Le SHA commun des futurs paquets est gelé : **`cc92d4cf31d4cbcff61fe4ad285ab6cd4cded0e3`**, poussé sans forçage sur `codex/first-client-release-1908`, puis vérifié sur le dépôt distant.

## Lancement vérifié

- Les quatre fichiers de version sont cohérents ; 11 tests des notes, traductions et contrats updater Windows/Mac passent. Le YAML est parsé et les 16 combinaisons branche/paramètres évaluées ne déclenchent aucun job en double.
- Pipeline CircleCI **264**, `d4029f87-d293-4bfe-8dd6-20ea9a3306a9`, workflow `37f7dc84-4fd7-4c76-8753-5746f30ca685`, créé le 29 septembre à 00:10:50 UTC.
- [Windows 174](https://circleci.com/gh/leartshbj1/zentra/174), [Android 175](https://circleci.com/gh/leartshbj1/zentra/175), [Apple 176](https://circleci.com/gh/leartshbj1/zentra/176). Contrôle API à 00:17:15 UTC : les trois jobs sont démarrés et toujours en cours, avec la source exacte attendue. Observation conservée dans `outputs/release1908/build-status.json`. Aucun résultat final ni artefact n’est encore attesté.
- Les recettes des fichiers Windows et Android exacts seront déclenchées après vérification des résultats de compilation ; la recette macOS est intégrée au job Apple. Les téléchargements publics et canaux restent sur 1.90.7 pendant ces contrôles.
- Les outils de distribution sont préparés dans `outputs/release1908/` : provenance, téléchargement, vérification des octets, signature et publication. Leur syntaxe est contrôlée (7 Python, 3 PowerShell et 2 JavaScript) ; les IDs des futures recettes Windows/Android restent non renseignés jusqu’à leur lancement. Aucun résultat de la version précédente n’est recopié pour simuler une validation.

## Contrôles avant distribution

1. Contrôler la cohérence des quatre fichiers de version, les notes dans les quatre langues et les régressions frontend. Le lot de préparation ajoute `rowIndex`, `workspaceFinancialRelations` et `dashboardDeadlines` aux tests des jobs Windows et Apple ; il ne constitue pas leur résultat d’exécution.
2. Compiler le même SHA pour Windows x64, macOS universel, iPhone ARM64 et Android ARM64 optimisé. Le workflow dédié `first-client-1908` est activé uniquement sur `codex/first-client-release-1908` lorsque le paramètre générique `release` est faux. Android utilise explicitement le mode `release`, y compris dans le workflow générique.
3. Télécharger et vérifier la provenance, les architectures, versions, icônes et empreintes. Exécuter les recettes des nouveaux paquets exacts : installation et relancement Windows, démarrage et relancement Mac, contrôles IPA/UIKit, clavier/thèmes/redémarrage Android. Les références de la recette Android doivent désigner le nouveau job, son SHA et son empreinte.
4. Signer et vérifier localement les artefacts updater Windows/Mac ainsi que l’APK avec l’identité persistante de préversion. Conserver les preuves et les checksums ; l’IPA destinée au sideload reste non signée.
5. Publier les actifs vérifiés sous un nouveau tag immuable, puis mettre à jour les téléchargements et canaux du site depuis sa source courante. Contrôler les fichiers publics, les versions des manifestes et leurs réponses sans cache avant de déclarer la livraison publiée.

## Limites inchangées

Les mesures de normalisation portent sur des données fictives et des lectures natives simulées : elles ne prouvent ni un démarrage global plus rapide, ni les performances connectées, ni une capacité multi-entreprise. La synchronisation en temps réel et les parcours réels sur deux appareils restent à valider séparément. Cette préparation ne rétablit ni Supabase ni le planificateur.

La signature updater ne remplace pas une signature de distribution reconnue par le système. Le refus Windows Code Integrity reste ouvert ; aucune installation locale ni modification des protections du PC n’est prévue par ce lot. macOS reste ad hoc et non notarié, iPhone nécessite une signature avant installation, Android conserve son identité de préversion. Aucun essai physique ni publication App Store ou Google Play n’est déduit de la préparation.
