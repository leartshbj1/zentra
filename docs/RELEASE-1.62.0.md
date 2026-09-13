# Zentra 1.62.0 — publication

## Contenu

Atelier de documents plus spacieux, outils de mise en page et aperçu. Choix de langue au premier démarrage et dans les paramètres : français, allemand, italien, anglais. Configuration, navigation HTML, tutoriel, collaborateurs, fiches de salaire et réglages de paie traduits avec conservation des brouillons et corrections guidées.

La traduction intégrale reste en préparation : certains écrans métier, messages natifs inconnus, contrôles Apple et PDF restent en français. Le sélecteur l’indique. Aucun taux légal n’est modifié par la traduction.

## Windows

Version 1.62.0, identifiant historique et schéma 59 conservés. Compilation locale terminée, signature Tauri produite. 1 483 tests d’interface passent dans les sources de publication. Le build TypeScript/Vite passe. Les parcours de réglages sont vérifiés en Edge et WebKit dans les quatre langues à 320, 390, 844 et 1 440 pixels, avec données synthétiques.

Six essais isolés du programme exact du paquet passent : premier lancement, redémarrage, création et lecture d’un profil 1.61, remplacement par 1.62 et redémarrage. Intégrité SQLite, pièces jointes, identité protégée, séquences et écritures équilibrées sont conservées. Une première tentative de recette a révélé que le vérificateur n’autorisait pas encore la création d’un jeu de données 1.61 ; sa liste a été complétée puis les essais repris dans de nouveaux profils. Le programme distribué n’a pas changé.

Ces essais ne lancent pas NSIS et ne prouvent pas une installation client. Pas de signature Authenticode. Les améliorations de langue et d’atelier ne modifient pas le moteur natif publié en 1.61.

Publié le 13 septembre 2026 sur Supabase Storage : `Zentra_1.62.0_x64-setup.exe`, 23 356 265 octets, SHA-256 `A1A8B1C430EF1A31A7872C563B3E3ABED950049CDA5C99A68E48F2E75D4E16AC`. Les fichiers téléchargés publiquement correspondent aux fichiers signés locaux. Le canal `latest-windows.json` annonce 1.62.0 et utilise un cache de 60 secondes ; contrôle public sans contournement du cache effectué à 16:42 UTC. Le manifeste partagé historique est inchangé. La page de téléchargement publiée affiche le lien et l’empreinte de cette version.

## Apple

Compilation effectuée sur les Mac M2 du compte individuel Codemagic, sans facturation activée, à partir du dépôt public. macOS : paquet universel Intel/Apple Silicon avec signature ad hoc, sans notarisation Apple. Signature de mise à jour Tauri effectuée localement après vérification des fichiers téléchargés. iPhone : IPA ARM64 sans signature Apple de distribution, destiné à Sideloadly/AltStore.

Le Mac 1.62.0 est publié sur Supabase. DMG : `Zentra_1.62.0_macos-universal.dmg`, 49 910 131 octets, SHA-256 `65421D5402CA542ED916E7414D744BEF0B3D8A26C5F3A6D6EB91CDA039CDB23B`. Archive de mise à jour : 49 880 445 octets, SHA-256 `04B605080586DA7FF12C9D2AB518FA94116A5B302B574F37DA197D60BCF213B0`. Source : `8e62e404bcf37f87fe3c9e4f8c39413d3eb23620`. `codesign` et `lipo` passent sur le runner. Les deux binaires contiennent l’endpoint Mac et la clé publique attendus ; la signature Tauri est vérifiée localement, puis les fichiers publics sont retéléchargés et comparés. `latest-macos.json` annonce 1.62.0 sous la cible `macos-universal`, cache 60 secondes. Les autres manifestes restent inchangés. Installation et lancement sur un Mac client non vérifiés.

L’éventuel exemplaire iPhone personnel reste séparé du paquet public ; aucune licence propriétaire ne doit être publiée sur le canal client. Voir les preuves finales de livraison pour connaître les plateformes effectivement disponibles.

L’IPA personnel est compilé avec succès sur Codemagic depuis `a3aceaf3912dd50dd9a7158ae672d9aa87b53509`. Contrôles local et distant réussis : version 1.62.0, identifiant `ch.zentra.mobile`, ARM64/iPhoneOS, iOS 15 minimum, archive intègre, absence de profil de distribution Apple. Taille : 24 856 075 octets. SHA-256 : `E2FD644B77662F0A8ED3C1A8A507D34D42FC8D8DE4D875D75534DDCC8A3AD2E7`. La licence propriétaire signée attendue et la clé publique sont présentes dans le binaire. Sa reconnaissance serveur a été vérifiée séparément ; l’installation, l’activation et le lancement sur un iPhone physique restent à confirmer. Ce fichier est livré uniquement au propriétaire.

Retour réel après livraison : le propriétaire a installé l’IPA 1.62.0 mais reste bloqué sur le message générique d’activation, même après plusieurs tentatives. L’activation sur son iPhone n’est donc pas réussie. La variante personnelle 1.62.1 supprime cette erreur fatale, conserve les restrictions d’écriture et affiche la cause réelle ainsi que l’identité de l’appareil. Elle propose une nouvelle tentative ou l’installation d’une licence fournie par l’assistance. Trois tests natifs et six parcours Edge/WebKit à 320, 390 et 1 440 pixels passent ; l’activation réelle devra être vérifiée avec le paquet corrigé.

Correctif personnel 1.62.1 livré le 13 septembre 2026 : compilation Codemagic réussie depuis `254489599eb122a4f1638583924488f31058ef6d`. IPA de 24 857 449 octets, SHA-256 `1E2855378CFD4B11FCBF8C1CFAD469E83CE20754E69FC7C9AB19FACFCE47BE26`. Le vérificateur confirme ARM64/iPhoneOS, la version, la licence propriétaire attendue et la présence du panneau de récupération. L’ancienne erreur générique est absente du binaire. Le serveur reconnaît la licence intégrée (HTTP 200 et jeton renouvelé à 17:29 UTC), mais ce contrôle ne prouve pas que l’identité de l’iPhone installé correspond. L’utilisateur doit remplacer l’ancienne version avec le même compte Apple ; son résultat d’activation reste attendu. Aucune licence personnelle n’est publiée sur les canaux publics.
