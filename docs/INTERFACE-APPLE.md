# Interface Zentra et navigation Apple

La refonte conserve les modules métier et les documents imprimés. Elle apporte un menu avec une sélection animée, une zone de travail claire, des indicateurs regroupés, des contrôles tactiles et un guide de 16 sujets. Le guide propose trois actions par sujet, un sommaire, une reprise locale et des commandes accessibles même sur petit écran. Le menu compact se ferme avec Échap et conserve le focus clavier dans son panneau.

## Matériaux natifs

- **macOS 26 et ultérieur** : un `NSGlassEffectView` AppKit contient la navigation native à quatre destinations. Son contenu est installé avec `contentView`, sur le thread principal. La classe est recherchée à l’exécution pour conserver la navigation HTML sur les anciens systèmes. Les événements passent par le canal Tauri ; les contrôles sont masqués pendant les dialogues et les rechargements.
- **iOS 26 et ultérieur** : les boutons UIKit utilisent `UIButton.Configuration.glass()` et `prominentGlass()`. UIKit gère leur matériau et leurs interactions. Le dock respecte le clavier, les zones sûres et les réglages de réduction des animations. Les changements de visibilité ne reconstruisent plus toutes les configurations des boutons.
- **Windows, Android et versions Apple antérieures** : l’interface partagée reste fonctionnelle. Sa transparence CSS n’est pas présentée comme du Liquid Glass natif.

Le matériau est limité à la navigation. Les formulaires, montants et documents gardent des surfaces lisibles. Les animations sont courtes et désactivées lorsque la personne demande une réduction des mouvements.

Références officielles : [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), [NSGlassEffectView](https://developer.apple.com/documentation/appkit/nsglasseffectview), [bouton UIKit prominentGlass](https://developer.apple.com/documentation/uikit/uibutton/configuration-swift.struct/prominentglass()).

## Vérification reproductible

`pnpm --dir desktop build:web` et `pnpm --dir desktop test:ui` vérifient l’interface. Le harnais de développement `desktop/tests/mobile-harness.html?browsing=1&design=1` contient uniquement des données fictives ; il n’entre pas dans le build de production. Les parcours `apple-workspace-journey.mjs`, `document-wizard-journey.mjs` et `design-experience-journey.mjs` contrôlent petits écrans, guide, création, aperçu, export simulé et clavier.

`native-navigation-journey.mjs` vérifie le pont avec une réponse native simulée, les modales, le menu et le repli vers les contrôles web. Démarrer Vite avec `TAURI_ENV_PLATFORM=macos` ou `ios`, puis utiliser le même `ZENTRA_QA_PLATFORM` pour le parcours. Cela ne valide pas le rendu AppKit/UIKit.

Le petit manifeste `desktop/tests/macos-native-check/Cargo.toml` compile **le véritable fichier AppKit utilisé par l’app**, sans copie ni faux AppKit. Il permet `cargo check --target aarch64-apple-darwin` et `--target x86_64-apple-darwin`, même depuis Windows si ces cibles Rust sont installées. Cette vérification des types ne remplace pas le build Tauri complet ni l’exécution sur Mac.

## Limites constatées le 9 septembre 2026

Les tâches GitHub [macOS 34372208523](https://github.com/leartshbj1/zentra/actions/runs/34372208523) et [UIKit 34372177383](https://github.com/leartshbj1/zentra/actions/runs/34372177383) ont été refusées avant toute étape : compte GitHub verrouillé pour un problème de facturation. Aucun nouvel installateur, IPA, DMG ou lot de mise à jour n’est issu de ces tâches.

Après rétablissement des exécutions, compiler la version complète avec Xcode/SDK 26, vérifier les contrôles sur macOS 26 et iOS 26, puis les versions anciennes, VoiceOver, contraste, réduction des mouvements, rotation, clavier et ouverture des documents. La validation des données et de la migration du schéma de développement reste un préalable distinct à toute distribution publique.
