# Interface Zentra et Liquid Glass

La présentation web et les surfaces React utilisent des fonds neutres, le vert Zentra, une typographie système, des contrôles arrondis et des transitions courtes. Les styles des documents imprimés restent indépendants. Le mode lecture utilise des en-têtes contrastés, même lorsqu'un modèle personnalisé est actif.

## iPhone : composants Apple réels

`desktop/plugins/zentra-mobile/ios/Sources/GlassNavigation.swift` utilise `UIButton.Configuration.glass()` et `prominentGlass()` pour Accueil, Projets, Ventes et Menu. Le matériau est fourni par UIKit, uniquement sous iOS 26 ou plus récent. Xcode avec le SDK iOS 26 est nécessaire ; le minimum de déploiement reste iOS 15. Le site, Android et les boutons HTML du contenu ne sont pas des composants Liquid Glass natifs.

Le plugin Tauri transmet les sélections par un Channel, limité aux quatre destinations. Le menu HTML reste présent tant que UIKit n'a pas confirmé sa disponibilité. Les anciennes installations et anciens iOS gardent les contrôles web. La navigation native se masque devant les fenêtres modales, le menu, le clavier et lors du rechargement web. Les boutons exposent leurs noms, sélection et grandes étiquettes d'accessibilité. Le système Apple gère les préférences de transparence et d'animation du matériau.

## Validation

- `design-experience-journey.mjs` : navigation, devis et factures, export simulé et reprise d'erreur, focus, réduction des animations, 320/390/768/1440 px.
- `design-reading-navigation-journey.mjs` : navigation dans les aperçus, totaux, contraste et absence de contrôles dans l'impression, portrait et paysage.
- `native-navigation-journey.mjs` : pont JavaScript avec backend simulé, disponibilité, ancien iOS, plugin absent et blocage des actions derrière les modales. Démarrer Vite avec `TAURI_ENV_PLATFORM=ios`, puis définir `ZENTRA_QA_ORIGIN` et `ZENTRA_PLAYWRIGHT_MODULE` si nécessaire.
- Workflow `mobile-preview.yml`, option `ios-glass` : compilation du plugin Swift complet et XCTest sur simulateur avec de vrais UIButton. Les options `ios` et `ipa` construisent l'application complète.

Au 9 septembre 2026, les validations web locales passent. La tentative GitHub Actions 34295916743 a été refusée avant toute étape : compte verrouillé pour un problème de facturation. La compilation Swift, le rendu natif, VoiceOver, les préférences d'accessibilité iOS, le passage portrait/paysage et l'installation sur un iPhone physique restent à vérifier. Aucun nouvel IPA validé n'est fourni par cette modification.

## Documentation officielle consultée

- [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) : réserver le matériau aux contrôles et à la navigation, éviter de le répéter dans le contenu, respecter l'accessibilité.
- [UIButton.Configuration](https://developer.apple.com/documentation/uikit/uibutton/configuration-swift.struct) : styles `glass()` et `prominentGlass()`.
- [Build a UIKit app with the new design — WWDC25](https://developer.apple.com/videos/play/wwdc2025/284/) : intégration des contrôles UIKit et regroupement dans les barres.
- [Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/liquid-glass) : principes et exemple Landmarks.
