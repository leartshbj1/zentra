# Zentra 1.71.1 — mode sombre harmonisé et réception discrète

## Correction

Sur mobile et ordinateur, les panneaux, en-têtes et sous-cartes du mode sombre sont séparés par des espacements et fonds distincts. Les icônes des paramètres suivent une palette neutre uniforme. Les menus sélectionnés utilisent un fond gris neutre et un accent vert limité à l’icône, sans cumul de rectangles verts. Le survol des rubriques est réservé aux appareils qui le prennent en charge. Les champs restent distincts des cartes qui les contiennent.

Le panneau plein écran, l’assombrissement et l’animation de chargement de la réception des données ont été supprimés. La page actuelle reste affichée et ses montants sont actualisés à réception. Le téléchargement et la préparation restent en arrière-plan.

La protection contre les écritures sur l’ancienne copie est conservée pendant le remplacement local final et le rafraîchissement React. Elle est activée avant l’appel natif et libérée après succès ou erreur, sans afficher de panneau. Le focus de recherche est rétabli sans faire défiler la page. Les formulaires actifs continuent de différer la réception.

Les notes de version sont disponibles en français, allemand, italien et anglais. Les anciennes règles CSS du panneau ont été retirées des deux thèmes.

## Vérification

- Construction web et TypeScript réussis.
- 24 tests ciblés réussis : apparence, cadence de synchronisation, notifications et notes de version.
- 138 contrôles d’apparence Chromium, en largeurs 320, 390 et 1440 px : aucune anomalie de contraste détectée, aucun débordement horizontal et restauration du thème clair après passage par le sombre.
- Les mêmes 138 contrôles d’apparence ont aussi réussi sur WebKit en CI Mac, sans anomalie de contraste détectée. Les six parcours d’accès à l’entreprise en clair/sombre et les gestes de menu/zoom des documents, images et PDF en trois formats ont réussi dans cette CI.
- Quatre parcours sur Chromium et WebKit, bureau 1280 px et mobile 390 px : réception automatique d’une facture puis d’un paiement, protection du formulaire, absence de panneau durant une réception volontairement retardée, conservation de la page et du contenu de recherche, récupération du focus après succès et après interruption.
- Réception automatique de la facture en 2,78 à 2,95 secondes dans ces parcours avec transport natif synthétique. Aucun essai physique iPhone ou Android revendiqué.
- Preuves locales : `.qa/company1711/proof.json` et captures dans le même dossier.
- Six lancements de l’exécutable Windows exact dans des profils isolés : démarrage, redémarrage et remplacement d’une version 1.61 contenant des données synthétiques. Intégrité et conservation de ces données vérifiées. Ce contrôle ne constitue pas une exécution interactive de l’installateur NSIS.
- Preuves complémentaires : `.qa/dark1711/appearance-proof.json`, `.qa/dark1711/preview.json` et `.qa/zentra-installer-packaged1711-verified/report.json`.

## Publication

Source des quatre compilations : `0b1393fc5eaa2fae88acb92301576d39e2c434d1`.

Les fichiers Windows, iPhone, Android et Mac sont publiés dans [la version 1.71.1](https://github.com/leartshbj1/zentra/releases/tag/v1.71.1). Les treize pièces jointes sont publiques et les empreintes des cinq binaires principaux correspondent aux artefacts vérifiés localement.

- Windows : `Zentra_1.71.1_x64-setup.exe`, 23 558 602 octets, SHA-256 `8F6D441BDE40966E20D42E62C42AD3B55F7A3F28163DB1A0ED95D559D41912BE`. Signature de mise à jour Ed25519 vérifiée indépendamment. Canal `latest-windows.json` relu publiquement sans paramètre de cache et confirmé en 1.71.1.
- iPhone : `Zentra-1.71.1-iPhone-unsigned.ipa`, 25 124 878 octets, SHA-256 `8466B39A893FFAE186624CF5E1DED940B24F988EBCC93C63E2021865DB9DA7E0`. Compilation Codemagic `6aa9a98c8d1b35ffb76dbb63`, ARM64 pour appareil physique, identifiant `ch.zentra.mobile`, iOS 15 minimum. Tests natifs Liquid Glass réussis en CI.
- Android : `Zentra-1.71.1-Android-arm64-test.apk`, 76 136 975 octets, SHA-256 `96B6073CD851A32B48889670AEE2AFE39B38DEA3E7B66F52B847ED2E6FDD8023`. Compilation Codemagic `6aa9a98d3892f6fecee1f3d8`, version et source contrôlées avant signature, signature durable et alignement 16 Ko vérifiés après signature. Empreinte du certificat : `23fc4c8370a5ec7ac15380825a46c599760607105d2df3d5668d3bdc76b6e670`.
- Mac : `Zentra_1.71.1_macos-universal.dmg`, 50 468 505 octets, SHA-256 `E784181371F92BF129A7A0C245D753C9B22135D49EDF9C39EBE4DB0E803CC873`. Archive de mise à jour `Zentra_1.71.1_macos-universal.app.tar.gz`, 50 445 970 octets, SHA-256 `F518A61EE04ECDCA0940B4268BE0E3434E09E07FEF1E0B35B03B7814018E0433`. Compilation Codemagic `6aa9a98d5bffbc373780b710`, source exacte et deux architectures contrôlées. Signature ad hoc vérifiée en CI, clé et URL de mise à jour intégrées vérifiées dans les deux exécutables. Signature Ed25519 de l’archive vérifiée indépendamment. Canal `latest-macos.json` confirmé en 1.71.1 sans paramètre de cache.

Les fichiers Windows, iPhone et Mac ont été téléchargés intégralement depuis le stockage public Supabase et leurs SHA-256 comparés. L’APK a été téléchargé intégralement depuis son lien public GitHub avec comparaison identique. Les anciens fichiers restent disponibles et le canal partagé historique `latest.json` est conservé. Preuves de publication : `.qa/public1711/`.

La [page de téléchargement](https://zentraapp.ch/download) référence 1.71.1 sur les quatre plateformes, avec les empreintes et tailles Windows/Mac vérifiées. Construction du site et quatre tests du contrat de téléchargement réussis. Source du site : `782d3be6ca8b7474c98c9d71334ef12a360ddc04`, version Sites 162 (`appgprj_6a942972adf481918671ac74e99e1fa7~appgver_16177f9eab38819184c1462d51348b35`). Déploiement `appgdep_6aa9b2e032f881919db9d20fbb13684f` confirmé `succeeded` le 15 septembre 2026 à 21:04:46 UTC, révision d’environnement 30. Archive de déploiement : SHA-256 `e7062f71d48acba3a912e68fe5941c857a35c9a241f75163614cb8e9ae096408`. Les routes et données de l’accès fondateur déjà présentes dans le site sont conservées.

Limites de distribution : Windows sans signature Authenticode, IPA non signé à signer via Sideloadly/AltStore, APK de test ARM64 avec débogage activé, Mac sans notarisation Apple. Aucun essai sur appareil physique mobile ni publication App Store/Play Store revendiqué. Les licences des comptes restent nécessaires ; aucun accès propriétaire n’est intégré aux binaires.
