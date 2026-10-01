---
name: "Zentra Gestion — atelier de travail Apple"
description: "Index stable, feuilles opaques, gestes continus et tâches lisibles."
colors:
  apple-canvas: "#f5f5f7"
  apple-paper: "#fff"
  apple-grouped: "#efeff2"
  apple-rail: "#ededf0"
  apple-ink: "#1d1d1f"
  apple-secondary: "#6e6e73"
  apple-line: "#dcdce1"
  apple-accent: "#24664f"
  apple-on-accent: "#fff"
  apple-selection: "#e2ece6"
  apple-focus: "#24664f"
  apple-danger: "#a93034"
  apple-danger-surface: "#fff0ef"
  apple-warning: "#785813"
  apple-warning-surface: "#fff6e4"
  apple-canvas-dark: "#171719"
  apple-paper-dark: "#242426"
  apple-grouped-dark: "#303033"
  apple-rail-dark: "#202022"
  apple-ink-dark: "#f5f5f7"
  apple-secondary-dark: "#ababb2"
  apple-line-dark: "#3b3b40"
  apple-accent-dark: "#acdbc3"
  apple-on-accent-dark: "#14362a"
  apple-selection-dark: "#294238"
  apple-focus-dark: "#acdbc3"
  apple-danger-dark: "#ffa5a5"
  apple-danger-surface-dark: "#41272a"
  apple-warning-dark: "#f0d292"
  apple-warning-surface-dark: "#393323"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "calc(32px * var(--zentra-ui-text-scale, 1))"
    fontWeight: 650
    lineHeight: 1.18
    letterSpacing: "-.025em"
  headline-mobile:
    fontSize: "calc(30px * var(--zentra-ui-text-scale, 1))"
    fontWeight: 650
    lineHeight: 1.18
    letterSpacing: "-.025em"
  dialog-title:
    fontSize: "calc(24px * var(--zentra-ui-text-scale, 1))"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-.02em"
  section-title:
    fontSize: "calc(20px * var(--zentra-ui-text-scale, 1))"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI Variable\", \"Segoe UI\", sans-serif"
    fontSize: "calc(15px * var(--zentra-ui-text-scale, 1))"
    lineHeight: 1.5
  body-mobile:
    fontSize: "calc(16px * var(--zentra-ui-text-scale, 1))"
    lineHeight: 1.5
  content:
    fontSize: "calc(14px * var(--zentra-ui-text-scale, 1))"
    lineHeight: 1.5
  control:
    fontSize: "calc(14px * var(--zentra-ui-text-scale, 1))"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0"
  navigation-mobile:
    fontSize: "calc(16px * var(--zentra-ui-text-scale, 1))"
  metadata:
    fontSize: "calc(13px * var(--zentra-ui-text-scale, 1))"
    lineHeight: 1.5
  dock-label:
    fontSize: "calc(12px * var(--zentra-ui-text-scale, 1))"
    fontWeight: 500
  metric:
    fontSize: "calc(24px * var(--zentra-ui-text-scale, 1))"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-.02em"
  notes-body:
    fontSize: "calc(18px * var(--zentra-ui-text-scale, 1))"
    lineHeight: 1.6
rounded:
  flat: "0px"
  status: "6px"
  segment: "7px"
  index: "8px"
  apple-radius-control: "10px"
  shortcuts: "12px"
  dock-selection: "14px"
  apple-radius-group: "16px"
  sheet-mobile: "18px 18px 0 0"
  modal: "20px"
spacing:
  segment-inset: "3px"
  compact: "8px"
  small: "12px"
  medium: "16px"
  group: "20px"
  section: "24px"
  work-space: "32px"
  work-space-compact: "24px"
  work-space-mobile: "16px"
  record-gap: "1rem"
  business-group: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.apple-accent}"
    textColor: "{colors.apple-on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.apple-radius-control}"
    padding: "9px 14px"
  button-primary-dark:
    backgroundColor: "{colors.apple-accent-dark}"
    textColor: "{colors.apple-on-accent-dark}"
    rounded: "{rounded.apple-radius-control}"
    padding: "9px 14px"
  button-secondary:
    backgroundColor: "{colors.apple-grouped}"
    textColor: "{colors.apple-ink}"
    rounded: "{rounded.apple-radius-control}"
    padding: "9px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.apple-accent}"
    rounded: "{rounded.apple-radius-control}"
    padding: "9px 14px"
  button-danger:
    backgroundColor: "{colors.apple-danger-surface}"
    textColor: "{colors.apple-danger}"
    rounded: "{rounded.apple-radius-control}"
    padding: "9px 14px"
  field:
    backgroundColor: "{colors.apple-paper}"
    textColor: "{colors.apple-ink}"
    rounded: "{rounded.apple-radius-control}"
  sidebar-item-selected:
    backgroundColor: "{colors.apple-selection}"
    textColor: "{colors.apple-ink}"
    rounded: "{rounded.index}"
    padding: "8px 10px"
  destination-selected:
    backgroundColor: "{colors.apple-paper}"
    textColor: "{colors.apple-ink}"
    rounded: "{rounded.segment}"
    padding: "8px 14px"
  filter-selected:
    backgroundColor: "transparent"
    textColor: "{colors.apple-accent}"
    rounded: "{rounded.flat}"
    padding: ".625rem 0"
  content-panel:
    backgroundColor: "{colors.apple-paper}"
    textColor: "{colors.apple-ink}"
    rounded: "{rounded.apple-radius-group}"
    padding: "24px"
  content-panel-mobile:
    backgroundColor: "{colors.apple-paper}"
    textColor: "{colors.apple-ink}"
    rounded: "{rounded.apple-radius-group}"
    padding: "20px 16px"
  dialog:
    backgroundColor: "{colors.apple-paper}"
    textColor: "{colors.apple-ink}"
    rounded: "{rounded.modal}"
  mobile-navigation:
    backgroundColor: "color-mix(in srgb, var(--apple-paper) 88%, transparent)"
    rounded: "{rounded.modal}"
    padding: "5px"
---

# Design System: Zentra Gestion

## Overview

**Creative North Star: "Atelier de travail"**

Un atelier de travail inspiré des conventions Apple Mail, Notes et Réglages : un index prévisible, une tâche lisible et des actions explicites. La police système, les blancs et les gris structurent la lecture ; le vert Zentra identifie l'action et la sélection. La hiérarchie repose sur les tailles, les poids, les séparateurs et l'espace.

Les feuilles de données sont opaques. La translucidité est réservée au dock mobile flottant ; le rail et les barres de travail restent stables. Les thèmes clair et sombre utilisent les mêmes rôles. Le mouvement répond à l'action : le tiroir suit le geste et les sélections se déplacent depuis leur position présentée.

Ce relevé décrit la refonte du 1er octobre 2026 dans l'application React/Tauri. Son périmètre est fixé par le [contrat Apple](.impeccable/apple-workspace-contract.md) et le [brief de surface](.impeccable/surfaces/src-workspaceapp-tsx.md). Le site public et le backend sont hors périmètre. Les fonctions, données, droits, validations et langues existants restent la contrainte produit ; leur vérification appartient au [compte rendu](.impeccable/apple-design-review-20261001.md). Aucun nouveau raster décoratif n'est livré ; les captures QA locales ne sont pas des assets de l'application.

**Key Characteristics:**

- Index stable, fonds de travail neutres et feuilles opaques à séparateurs internes.
- Typographie système avec dimensionnement optique et chiffres tabulaires dans les données métier.
- Accent vert fonctionnel et sélection tonale, sans changement de forme des icônes.
- Navigation à ressort depuis la valeur visible, avec reprise du geste et mouvement réduit.
- Compositions bureau et téléphone qui conservent les libellés, les actions et le réglage de taille du texte.

## Colors

La palette associe le vert Zentra, le blanc opaque et des gris froids en clair ; le sombre utilise des graphites et un accent vert pâle. Le frontmatter extrait les valeurs littérales de `apple-workspace.css`. Les clés suffixées `-dark` correspondent aux remplacements du thème sombre. Les propriétés `work-*`, `zen-*`, `surface-*` et les couleurs métier sont raccordées aux mêmes rôles dans les surfaces concernées ; elles ne constituent pas une palette concurrente.

### Primary

- **Vert d'action** : `apple-accent`, avec `apple-on-accent` comme premier plan associé. Actions principales, icônes actives et liens fonctionnels.
- **Sélection tonale** : `apple-selection` pour la destination active et les états approuvés. Le texte reste encre ou accent selon le composant.
- **Focus** : `apple-focus` porte le contour clavier ; son rôle reste distinct même lorsqu'il partage la couleur de l'accent.

### Neutral

- **Fond de travail** : `apple-canvas`, visible autour des feuilles.
- **Papier** : `apple-paper`, pour les panneaux, dialogues et formulaires.
- **Index** : `apple-rail`, un ton distinct du papier ; **groupe** : `apple-grouped`, pour recherche, segments et informations complémentaires.
- **Encre et contexte** : `apple-ink` et `apple-secondary` ; **séparateur** : `apple-line`.
- **Danger et attention** : les couples `apple-danger` / `apple-danger-surface` et `apple-warning` / `apple-warning-surface` expriment les états métier existants. Ils conservent un texte explicite.

Les rampes OKLCH du sidecar sont des aperçus synthétisés à partir des couleurs sources, pas des tokens supplémentaires de l'application.

**The Functional Color Rule.** La couleur renforce une action, une sélection ou un statut écrit ; elle ne remplace jamais son libellé.

## Typography

**Interface Font:** -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif. Les surfaces financières ajoutent `system-ui` avant le dernier repli. `font-optical-sizing: auto` est activé dans la couche partagée. Aucun téléchargement de police n'est requis.

### Hierarchy

- **Headline / headline-mobile** : titres de page, poids marqué et suivi serré ; les valeurs incluent le facteur de taille du texte.
- **Dialog-title / section-title** : tâches modales et groupes de contenu. Les titres Notes et Rapports ont leur composition de rédaction propre.
- **Body / body-mobile / content** : contexte courant et texte métier ; les paragraphes de section atteignent au plus 70 caractères de largeur.
- **Control / navigation-mobile** : action compacte sur bureau, libellé agrandi au toucher. La destination active conserve un poids de 600.
- **Metadata / dock-label** : contexte de l'enregistrement et raccourcis bas. Ce sont des rôles secondaires, pas des tailles de corps.
- **Metric** : synthèse financière ; les couches métier appliquent `tabular-nums` aux montants et compteurs.
- **Notes-body** : rédaction, avec une interligne plus ouverte.

Le réglage existant propose 100, 125, 150, 175 et 200 %. La racine `rem` reste stable ; le texte utilise `calc(... * var(--zentra-ui-text-scale, 1))`. Les couches Finance et Opérations emploient notamment `rem` pour l'espace et les minimums. Les minimums en pixels de certaines primitives n'imposent pas une hauteur maximale : le contenu et le retour à la ligne peuvent les agrandir. Ne pas revendiquer une intégration native Dynamic Type à partir de ce seul réglage web.

**The Scaled Type Rule.** Une taille d'interface explicite inclut --zentra-ui-text-scale. Agrandir le texte laisse les lignes et les groupes se réorganiser ; les documents conservent leur géométrie propre.

## Layout

Le bureau dispose d'un index de 244 pixels, d'une barre de 56 pixels minimum et d'une gouttière `work-space`. Entre 861 et 1100 pixels, l'index passe à 218 pixels et la gouttière adopte `work-space-compact`. À 860 pixels et moins, le contenu remplit la largeur, le menu devient un tiroir de `min(340px, 88vw)` et la gouttière suit `work-space-mobile`. Le mode macOS utilisant la navigation native possède un tiroir de 300 pixels et un contenu sans marge de rail ; ces règles CSS ne prouvent pas un essai installé sur macOS.

Les actions d'en-tête reviennent à la ligne. Sur téléphone, le titre et ses actions occupent des lignes séparées, avec une aide de 44 pixels positionnée dans le coin de l'en-tête. Les actions principales peuvent prendre la largeur disponible. Les boutons partagés font au moins 40 pixels sur bureau et 44 pixels sur téléphone ; les variantes et parcours spécialisés peuvent relever ce minimum. Le dock conserve des destinations de 54 pixels minimum.

Les safe areas suivent `var(--safe-top, env(safe-area-inset-top))` et les équivalents droit, bas et gauche. Le dock réserve au moins 12 pixels des côtés et 10 pixels du bas ; les valeurs natives peuvent augmenter cet espace. Sa hauteur mesurée alimente `--zentra-mobile-nav-height`, qui participe à la réserve basse du contenu. Les éditeurs documentaires à texte agrandi laissent défiler l'ensemble du formulaire et leurs actions.

### Compositions métier

- **Accueil** : bande financière commune, quatre colonnes puis deux sur bureau compact ; données, période et liens restent liés. Le téléphone conserve son accueil et ses raccourcis existants.
- **Comptabilité / Banque** : navigation, période et filtres distincts ; état de la période explicite. Les mouvements bancaires gardent leur décision juste après leurs données. Seuls les tableaux de Comptabilité marqués `data-apple-records` deviennent des enregistrements à deux colonnes puis une sur téléphone.
- **Catalogue / Achats / Relances / Paie** : lignes à séparateurs, regroupant identité, prix ou solde, état et actions. Les actions reviennent à la ligne ; les formulaires conservent leurs validations et pièces sources.
- **Automation** : journal complet en premier, complément factuel de 15rem à côté puis dessous à 1200 pixels. Activité, À suivre et Réglages restent les destinations existantes.
- **Notes / Rapports / Réglages** : index séparé de la feuille de travail. Notes et Rapports empilent leurs régions à 760 pixels. Réglages utilise un index de 288 pixels au-dessus de 1100 pixels, puis des groupes de lignes et une feuille de détail.
- **Agenda** : contrôles de période, calendrier et liste de travail ; les commandes se répartissent par groupe sur téléphone. Aux très petites largeurs, la grille calendaire conserve une largeur locale minimale ; la vérifier par défilement local plutôt que masquer les jours.
- **Accès et installation** : même palette et texte agrandi pour les étapes, le compte entreprise, le cloud et les informations d'abonnement. L'introduction de marque déjà approuvée est une exception séparée.

Cette liste décrit les familles visuelles ; les contrats de surface gardent l'autorité sur l'ordre et la composition détaillés. Les sous-pages et les données traduites restent celles du produit.

**The Intrinsic Control Rule.** Les libellés traduits gardent leur taille et leur contenu. Réorganiser les groupes et leurs actions avant de comprimer un contrôle.

## Elevation & Depth

Les feuilles, l'index et la barre supérieure n'ont pas d'ombre ambiante. Le ton, l'espace et les traits internes suffisent. Le dock flottant combine le papier à 88 % avec un flou de 20 pixels et une saturation de 1.15. La préférence de transparence réduite le rend opaque et supprime le flou.

### Shadow Vocabulary

- **Sélection de segment** : `0 1px 3px rgb(0 0 0 / 8%)`, sous la surface qui indique la destination courante.
- **Dock flottant** : `0 6px 24px rgb(0 0 0 / 12%)`.
- **Dialogue** : `0 24px 80px rgb(0 0 0 / 24%)`, avec voile arrière à 30 % et sans flou de fond.
- **Tiroir macOS à navigation native** : `12px 0 60px rgb(0 0 0 / 15%)`.
- **Alias work-shadow** : `0 8px 28px rgb(0 0 0 / 8%)`, remplacé par 22 % en sombre pour les usages hérités qui le consomment. Ce n'est pas l'ombre actuelle du composant Modal.

**The Functional Depth Rule.** Les feuilles au repos se distinguent par leur ton et leurs séparateurs. Le flou appartient au chrome flottant ; le voile et l'ombre forte appartiennent aux tâches modales.

Le retour de pression d'un bouton démarre avec `:active` : `scale(.98)` et luminosité `.94`. Ses changements de fond et couleur durent 120ms, son déplacement 100ms. Le mouvement réduit retire le déplacement. Des transitions héritées de 160ms subsistent dans des lignes et contrôles contextuels.

Le changement de page conserve `useScreenArrival` : 220ms, opacité de `.72` à `1`, déplacement vertical de 4 pixels, sans remonter les éditeurs ni déplacer le focus. Il est annulé au changement de destination ou à l'activation du mouvement réduit. Ce léger mouvement chronométré ne pilote ni le tiroir ni la sélection.

## Shapes

Les groupes de contenu utilisent `apple-radius-group` ; les boutons et champs utilisent `apple-radius-control`. Les sélections d'index ont le rayon `index`, les segments le rayon `segment`, le dock `modal` et ses sélections `dock-selection`. Les lignes internes restent carrées. Les dialogues mobiles n'arrondissent que leurs coins supérieurs, avec `sheet-mobile`.

Les petits repères de statut restent reconnaissables. Les icônes de ligne changent de couleur avec l'état ; elles ne changent ni de forme ni d'échelle pour indiquer la sélection. Les traits ne délimitent pas une carte autour de chaque champ.

## Components

### Buttons

Actions explicites et opaques. Le primaire utilise accent / premier plan associé ; le secondaire groupe / encre ; le ghost reste transparent et vert ; le danger utilise son couple sémantique. Les variantes `dark` et iconiques des composants existants restent disponibles.

Le focus clavier partagé utilise un contour de 2 pixels décalé de 3 pixels. La pression suit le traitement de profondeur. Le primaire conserve son premier plan dans les deux thèmes ; les effets de survol sont réservés aux pointeurs compatibles. Une action désactivée garde son état et une opacité de `.5` dans la primitive partagée. Les états de chargement et confirmations restent contrôlés par le parcours métier.

### Chips / filters

Les filtres du journal Automation restent des commandes textuelles à fond transparent ; un soulignement de 2 pixels et le texte d'accent indiquent `aria-pressed=true`. Les autres filtres, statuts et compteurs conservent leurs rôles. Un statut approuvé peut utiliser la sélection verte ; attente, refus et erreur gardent leur libellé.

### Cards / Containers

Les panneaux sont des feuilles opaques, sans ombre ni bordure extérieure. Les panneaux imbriqués deviennent des sections internes transparentes. Les tableaux conservent leur en-tête de groupe, leur encre secondaire et leurs séparateurs. Les états vides gardent l'action existante ; aucun événement, montant, gain ou compteur n'est inventé pour meubler la surface.

**The Shared Sheet Rule.** Garder l'identité, les montants, l'état et les actions d'un enregistrement sur la même feuille. Utiliser des lignes internes plutôt qu'une carte autour de chaque détail.

### Inputs / Fields

Les champs usuels ont un fond papier, une bordure de trait et une caret d'accent. Ils font 44 pixels minimum, héritent du texte système et passent à un texte de 16 pixels multiplié par le réglage sur téléphone. Le focus de clavier reste visible ; la validation conserve une bordure de danger et son erreur écrite. Les recherches intégrées utilisent le fond de groupe et un focus de groupe. Les cases, radios, interrupteurs et champs spécialisés conservent leur comportement.

### Navigation and continuous motion

L'index actif combine une surface tonale mobile, texte encre, icône verte et poids 600. `useNavigationSelection` mesure le contrôle réel avec le défilement, les changements de dimensions et les mutations. Deux ressorts indépendants X / Y de réponse `.24` déplacent la sélection depuis leur valeur courante ; la première mesure est placée directement. Les dimensions sont mesurées, sans animer leur taille. La navigation et l'action deviennent disponibles immédiatement.

`useEdgeDrawer` lit la transformation réellement présentée avant une reprise. Après discrimination horizontale, le tiroir suit la distance du doigt ; la position reste bornée entre `-width` et `0`, sans élasticité ajoutée. Au relâchement, il estime la vitesse récente sur 100ms, la projette avec une décélération `.998`, choisit l'état ouvert ou fermé, puis transmet cette vitesse au ressort critique de réponse `.3`.

Le moteur `springMotion` évalue analytiquement le ressort critique : pas de rebond programmé et pas de durée fixe d'arrivée. Re-cibler conserve la position et la vitesse. Il termine à moins de `.2` pixel et `3` pixels/seconde du repos. Pointer Events avec capture servent la souris ou le stylet ; le toucher utilise un chemin Touch Events annulable compatible WebKit. Le geste attend 8 pixels de mouvement horizontal et une dominance de 1.2 ; un mouvement vertical de plus de 10 pixels l'abandonne. Il exclut champs, contenu éditable et documents tactiles, respecte les dialogues et s'annule pour un second toucher, une perte de capture ou une perte de focus.

Une fois un glissement actif terminé, un clic de pointeur accidentel est supprimé pendant une fenêtre de 350ms ; les activations clavier restent valides. La préférence de mouvement réduit place directement le ressort à sa destination, y compris si elle change pendant le mouvement. Aucun son ou retour haptique n'est ajouté.

**The Continuous Motion Rule.** Le geste et son retour partagent une valeur présentée. Une nouvelle destination conserve la vitesse du ressort ; aucun verrou d'entrée n'attend la fin du mouvement.

### Dialogues and document readers

Les dialogues gardent une feuille opaque, un contexte et leurs actions. Le composant Modal gère le focus initial, le cycle Tab, Échap, l'isolement des couches et le retour au déclencheur. Le tiroir fermé utilise `inert` et `aria-hidden` ; la navigation accessible conserve ses marqueurs de destination.

Le lecteur documentaire reçoit la palette Apple dans son chrome, ses commandes et son sommaire. Son papier reste contrôlé par le document. Les couches Apple sont limitées à `@media screen` ; `text-size.css` fixe le facteur à 1 pour les papiers de document et l'impression. Ce choix préserve identité, couleurs, mise en page et typographie d'impression existantes.

### Existing finite brand arrival

L'introduction Zentra approuvée conserve son wordmark et son dessin canvas de marque. Son fond, ses lumières et ses actions restent une exception finie. Elle ne fournit pas la palette des écrans de travail et ne se rejoue pas à chaque changement de menu. Aucun nouveau raster n'a été créé pour cette refonte.

## Do's and Don'ts

### Do:

- **Do** employer ensemble les rôles clair/sombre de la palette Apple et leurs alias métier.
- **Do** conserver la famille système, le réglage de taille du texte, les chiffres tabulaires et les libellés traduits.
- **Do** garder les états réels, les droits, les confirmations, les erreurs écrites et le focus visibles.
- **Do** donner priorité aux variables natives --safe-* avec env() en repli, et réserver l’espace réellement occupé par la navigation basse.
- **Do** conserver le défilement vertical, les gestes documentaires et les champs pendant une tentative de geste de navigation.
- **Do** séparer le chrome écran du papier imprimé et des couleurs choisies pour les documents.
- **Do** maintenir les ressorts interruptibles, le mouvement réduit et le dock opaque avec transparence réduite.

### Don't:

- **Don't** transformer les listes métier ou chaque réglage en une grille de cartes décoratives.
- **Don't** ajouter de verre ou de dégradé décoratif dans les feuilles de travail.
- **Don't** réduire une taille de texte choisie pour faire tenir une action, un montant ou une traduction.
- **Don't** remplacer une donnée ou un état écrit par une couleur ou une icône seule.
- **Don't** remettre un déplacement CSS chronométré sur le tiroir ou les sélections pilotés par ressort.
- **Don't** présenter les essais navigateur comme une validation matérielle iOS/macOS, une publication ou une livraison native.

Sources actuelles : [apple-workspace.css](src/apple-workspace.css), [apple-business.css](src/apple-business.css), [apple-operational.css](src/apple-operational.css), [apple-secondary.css](src/apple-secondary.css) et [apple-access.css](src/apple-access.css), importées dans cet ordre après les couches historiques dans [main.tsx](src/main.tsx). Les héritages nécessaires restent dans les feuilles précédentes ; leurs valeurs dépassées ne sont pas des alternatives de design. Les palettes Apple possèdent leurs deux thèmes et sont exclues du générateur `scripts/build-dark-palette`. Mouvement et accessibilité : [springMotion.ts](src/springMotion.ts), [useEdgeDrawer.ts](src/useEdgeDrawer.ts), [useNavigationSelection.ts](src/useNavigationSelection.ts), [touchExperience.css](src/touchExperience.css), [text-size.css](src/text-size.css), [SectionTabs.tsx](src/SectionTabs.tsx), [WorkspaceApp.tsx](src/WorkspaceApp.tsx) et [ui.tsx](src/ui.tsx).

La préférence de contraste renforcé ne possède pas de variante dédiée dans ces cinq couches. Les polices et matériaux sont des équivalents web des conventions Apple. La documentation décrit le code ; les essais navigateur, leurs preuves et leurs limites sont consignés séparément. Elle ne vaut pas publication, validation native, essai matériel ou certification de tous les parcours serveur.
