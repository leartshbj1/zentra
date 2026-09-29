# Zentra 1.90.8 — publiée, preuves et limites

29 septembre 2026, publication vérifiée jusqu’à 01:11 UTC (03:11 Europe/Zurich). **La version native publiée est 1.90.8 sur les quatre plateformes.** Les douze actifs GitHub sont publics depuis 01:01:04 UTC ; Sites 299 a réussi à 01:08:28 UTC. Les quatre téléchargements principaux et les trois manifestes de mise à jour ont été contrôlés à 01:08:58 UTC, puis leur présence sur la page de téléchargement à 01:11:02 UTC. Publication, installation sur le PC utilisateur et recette connectée restent des faits distincts ; l’objectif complet n’est pas clos.

## Contenu publié

- Accueil : les raccourcis de création choisis suivent le résumé financier. Les factures à régler sont triées par échéance et chaque ligne ouvre la facture choisie.
- Téléphone : montants, actions et navigation de l’accueil adaptés au texte agrandi ; rubriques de suivi traduites en français, allemand, italien et anglais.
- Historique financier : index temporaires pour éviter les recherches répétées lors de la normalisation des relations entre documents. Montants, ordre source et liens existants conservés, sans cache partagé entre entreprises. Voir [la mesure et ses limites](NORMALISATION-HISTORIQUE-FINANCIER-20260929.md).

Les changements applicatifs sont documentés par `55152c8b9279a13d693c76bff2bb4b0a1308dfff` (normalisation) et `1a4767f0838913e8f4a09fe4bb3b3df9c260fbcb` (accueil). Le SHA natif commun des paquets publiés est **`cc92d4cf31d4cbcff61fe4ad285ab6cd4cded0e3`**, poussé sans forçage sur `codex/first-client-release-1908`, vérifié sur le dépôt distant et cible de la [release v1.90.8](https://github.com/leartshbj1/zentra/releases/tag/v1.90.8). Les recettes Windows/Android utilisent le vérificateur **`c94162093f978cd160f6ae05a569d3a1ea9167ea`** sur ces paquets ; son SHA ne remplace pas leur source applicative.

## Compilations et recettes vérifiées

- Les quatre fichiers de version sont cohérents ; 11 tests des notes, traductions et contrats updater Windows/Mac passent. Le YAML est parsé et les 16 combinaisons branche/paramètres évaluées ne déclenchent aucun job en double.
- Pipeline CircleCI **264**, `d4029f87-d293-4bfe-8dd6-20ea9a3306a9`, workflow `37f7dc84-4fd7-4c76-8753-5746f30ca685`, créé le 29 septembre à 00:10:50 UTC.
- [Windows 174](https://circleci.com/gh/leartshbj1/zentra/174), [Android 175](https://circleci.com/gh/leartshbj1/zentra/175) et [Apple 176](https://circleci.com/gh/leartshbj1/zentra/176) ont réussi sur la même source native. L’observation API du 29 septembre à 01:10:08 UTC est conservée dans `outputs/release1908/build-status.json` ; les fichiers `windows/download-proof.json`, `android/download-proof.json` et `apple/download-proof.json` vérifient la provenance et les octets reçus.
- La recette [Windows 178](https://circleci.com/gh/leartshbj1/zentra/178) a réussi à 00:59:11 UTC : installation cloud du paquet 174, démarrage et relancement du binaire empaqueté, profil isolé, schéma SQLite 60 et intégrité vérifiés. Le marqueur NSIS est contrôlé. Preuves : `smoke-windows/download-proof.json` et `smoke-windows/windows-smoke.json`. Ce contrôle n’est ni une interaction complète avec l’interface ni une installation sur le PC de l’utilisateur.
- La recette macOS intégrée à 176 a démarré puis relancé l’archive universelle exacte dans un profil isolé : intégrité SQLite, architectures et signature ad hoc vérifiées. L’archive porte ensuite la signature updater vérifiée localement. Cela ne vaut pas notarisation ni essai interactif sur le Mac d’un client. L’IPA ARM64 et ses deux icônes compilées sont vérifiés ; l’IPA reste non signée et non testée sur iPhone physique.
- L’APK optimisé 175, non débogable, est signé avec le certificat persistant de préversion. La recette [Android 177](https://circleci.com/gh/leartshbj1/zentra/177) a réussi sur son contenu exact, resigné uniquement pour l’émulateur : écran de compte, thèmes natifs, champ visible au-dessus du clavier, brouillon conservé et relancement. Deux captures 320 × 640 du thème sombre et du clavier ont été relues localement. Aucune connexion de compte ni entreprise réelle n’est déduite de cet essai.
- Les preuves de distribution sont conservées dans `outputs/release1908/` : provenance, téléchargement, vérification des octets, signatures updater Windows/Mac, certificat Android et publication. `release-plan.json` décrit la configuration ; les résultats datés sont dans les preuves de téléchargement et de recette. Aucun résultat de la version précédente n’est recopié pour simuler une validation.

## Publication et contrôles publics

`github-published-proof.json` confirme une release non brouillon, douze actifs et leur taille/empreinte. Les quatre liens principaux ont répondu HTTP 200 anonymes avec les tailles exactes dans `public-head-proof.json` :

| Plateforme | Fichier public | Octets |
|---|---|---:|
| Windows x64 | `Zentra_1.90.8_x64-setup.exe` | 24 499 463 |
| macOS universel | `Zentra_1.90.8_macos-universal.dmg` | 54 782 073 |
| iPhone ARM64 | `Zentra-1.90.8-iPhone-unsigned.ipa` | 27 408 625 |
| Android ARM64 | `Zentra-1.90.8-Android-arm64-test.apk` | 39 850 718 |

**Sites 299**, source **`dcf9a0d726acdb59072284e4ae4c32ed1d64d667`**, est publié avec l’état `succeeded` à 01:08:28 UTC. Déploiement `appgdep_6abb0f76d9a88191aa45edb3f05b5ec7`, révision d’environnement 37 inchangée, archive de 701 fichiers. `site-publish-proof.json` conserve le commit et les empreintes de l’archive exacte.

`update-channel-live-proof.json` confirme que `latest.json`, `latest-windows.json` et `latest-macos.json` répondent HTTP 200, anonymes et `no-store`, annoncent 1.90.8 et correspondent aux manifestes locaux. Le canal inconnu répond 404. Les signatures updater Windows/Mac ont été vérifiées avant cette publication. Les anciennes releases et les manifestes historiques Supabase ne sont pas remplacés.

`download-page-proof.json`, daté du 29 septembre à 01:11:02 UTC, confirme HTTP 200 pour `https://zentraapp.ch/download` et la présence des quatre noms de fichiers 1.90.8 ci-dessus.

Historique : au contrôle du 29 septembre à 00:51 UTC, Windows 174 était encore en compilation et 1.90.7 restait publiée. Ces constats précédaient la réussite de 174 à 00:55:14 UTC, de 178 à 00:59:11 UTC et la publication ci-dessus ; ils ne décrivent plus l’état courant.

## Limites inchangées

Les mesures de normalisation portent sur des données fictives et des lectures natives simulées : elles ne prouvent ni un démarrage global plus rapide, ni les performances connectées, ni une capacité de 150 entreprises simultanées. La synchronisation en temps réel et les parcours réels sur deux appareils restent à valider séparément. Cette publication ne prouve le rétablissement ni de Supabase ni du planificateur.

Une [mesure Rust optimisée distincte](VOLUMES-OPTIMISES-20260929.md), sur la même source applicative et un historique fictif, comprend trois passages après échauffement : médiane de lecture 1 289,95 ms et de sérialisation 162,17 ms, pour 49 718 748 octets. Les 110 tables et trois pièces restent identiques. Le binaire de test GNU diffère de l’installateur MSVC ; ouverture à froid, IPC, normalisation JavaScript, rendu, machine modeste et capacité serveur sont exclus. Aucun gain global n’est déduit d’une comparaison avec les anciens tests debug.

La sonde du **29 septembre à 01:09:30.902 UTC** (`outputs/release1908/auth-readiness.json`) reçoit encore HTTP **503**, « L’authentification est temporairement indisponible. », pour une tentative de connexion avec une adresse fictive inexistante et l’origine requise. Aucun compte réel connecté, aucune inscription ni demande d’e-mail. Ce résultat constate l’indisponibilité de l’authentification ; ce n’est pas un contrôle direct de la facturation Supabase.

La signature updater ne remplace pas une signature de distribution reconnue par le système. Windows reste sans Authenticode et le refus Code Integrity du PC utilisateur reste ouvert ; aucune installation locale ni modification des protections de ce PC n’a été effectuée dans ce lot. Son dernier état vérifié reste 1.90.5. macOS reste ad hoc et non notarié ; l’IPA est non signée et nécessite une signature avant installation. Android conserve son identité persistante de préversion, distincte du certificat jetable employé par la recette émulateur. Aucun essai sur appareil physique ni publication App Store ou Google Play n’est déduit de la mise à disposition des fichiers.
