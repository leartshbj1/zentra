# Zentra 1.90.7 — publiée le 28 septembre 2026

- Chargement des grands historiques accéléré et périodes comptables mieux indiquées.
- Bilans PDF : titres conservés avec leurs lignes et en-têtes répétés ; rapports de projet dans la langue choisie, y compris sur les pages suivantes.
- Guide, planning et écran de mise à jour plus lisibles avec le texte agrandi, en français, allemand, italien et anglais.
- Introduction corrigée sur les appareils lents, logo et préférences mieux disposés sur téléphone.
- Android : paquet optimisé non débogable, clavier sans recouvrement du champ et bordures natives cohérentes en clair/sombre.
- Refus de mise à jour Windows expliqués sans demander de désactiver les protections.

## Validation et distribution

Les douze fichiers de la [release 1.90.7](https://github.com/leartshbj1/zentra/releases/tag/v1.90.7) sont publics depuis 04 h 53. Les quatre téléchargements répondent HTTP 200 avec les tailles attendues. **Sites 294 est publié à 04 h 56**, source `b863979575e3f96a3d05aa6ea7549abb9916b89b`, environnement 37 inchangé ; les trois canaux de mise à jour annoncent 1.90.7 et répondent HTTP 200 sans cache à 04 h 57. Un canal inconnu reste refusé 404. Les anciennes releases et les manifestes Supabase historiques sont inchangés.

Source commune des quatre plateformes : **`958787be4e608b89a357f98c73d0c236bda677b4`**. Builds CircleCI : Android 167, Windows 168, Mac/iPhone 169. Les recettes utilisent le vérificateur `4d692d2561069b3c01944108888258d7651fe687`, dont seules deux sources de CI/test diffèrent de l’application gelée.

| Plateforme | Fichier principal | Taille | Vérification |
|---|---|---:|---|
| Windows x64 | `Zentra_1.90.7_x64-setup.exe` | 24 495 547 octets | Installation du paquet exact, deux démarrages et intégrité SQLite (173) ; icônes et signature updater |
| Mac Intel et Apple Silicon | `Zentra_1.90.7_macos-universal.dmg` | 54 779 133 octets | Deux architectures, démarrage/relancement isolés, codesign ad hoc, icône et signature updater de l’archive |
| iPhone | `Zentra-1.90.7-iPhone-unsigned.ipa` | 27 407 677 octets | Véritable binaire iPhone ARM64, icônes compilées identiques et cinq tests UIKit réussis sur simulateur |
| Android ARM64 | `Zentra-1.90.7-Android-arm64-test.apk` | 39 850 718 octets | Certificat persistant épinglé, 964 fichiers applicatifs identiques après signature, alignement 16 Ko ; recette de l’APK sur émulateur (172) |

1 825 tests frontend, TypeScript et 50 actifs de marque passent avant publication. Le site ajoute 14 tests des téléchargements/canaux, TypeScript et build. Les tests natifs de chaque compilation sont consignés dans les preuves CI. Les essais de bureau utilisent uniquement des profils fictifs isolés ; aucune entreprise réelle n’est modifiée.

La recette Android 172 confirme le clavier, les thèmes natifs, le retour aux dimensions initiales, le redémarrage et l’identité locale conservée. Cinq captures finales relues. Les essais 170 et 171 avaient été arrêtés par des problèmes de fixture : dialogue ANR de l’application Messages, puis service téléphonique non prêt avant la mise hors réseau. Messages est désactivé uniquement dans l’émulateur neuf et la préparation attend désormais le service ; aucun défaut applicatif n’est masqué et l’APK testé reste exactement celui de 167. L’émulateur reçoit un certificat jetable distinct du certificat persistant de l’APK publié ; aucune installation physique de ce dernier n’est revendiquée.

Preuves : `outputs/release1907/`, notamment `SOURCES.json`, `source-equivalence-proof.json`, les vérifications de chaque plateforme, `android-visual-proof.json`, `github-published-proof.json`, `public-head-proof.json`, `site-publication-proof.json` et `update-channel-live-proof.json`.

Windows nécessite encore une signature d’éditeur reconnue pour les appareils qui imposent cette protection. macOS reste signé ad hoc, sans notarisation Apple. L’IPA iPhone nécessite une signature avant installation. Android utilise l’identité persistante de préversion. Aucun paquet n’est présenté comme une publication App Store ou Google Play.

Le dernier état vérifié du PC utilisateur reste 1.90.5 : aucune nouvelle installation locale n’est tentée après le refus Code Integrity documenté. La publication des canaux ne prouve pas que cette protection accepte désormais le fichier. Aucun essai physique iPhone/Android ou recette connectée à deux appareils n’est déduit des contrôles cloud.

Cette mise à jour ne lève pas les quotas Supabase et ne rétablit pas le planificateur refusé par GitHub. L’utilisateur prévoit le passage à Supabase Pro le 29 septembre ; les essais connectés restent à réaliser après rétablissement. Le travail local est conservé pendant l’indisponibilité.
