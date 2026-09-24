---
name: Zentra Studio
description: "Une famille de produits verte, claire et tactile, documentée depuis le code final."
colors:
  studio-green: "#225b40"
  studio-green-hover: "#173e2d"
  studio-tint: "#e9f0ec"
  studio-paper: "#fff"
  studio-canvas: "#f5f6f7"
  studio-ink: "#19251f"
  studio-muted: "#626b66"
  studio-rule: "#dce1de"
  product-focus: "#42875e"
  category-paper: "#eceef0"
  category-ink: "#505a61"
typography:
  display:
    fontFamily: "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(46px, 5vw, 70px)"
    fontWeight: 540
    lineHeight: 1.1
    letterSpacing: "-.035em"
  headline:
    fontFamily: "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(32px, 3.7vw, 52px)"
    fontWeight: 540
    lineHeight: 1.13
    letterSpacing: "-.035em"
  title:
    fontFamily: "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "28px"
    fontWeight: 550
    lineHeight: 1.2
    letterSpacing: "-.025em"
  lead:
    fontFamily: "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "19px"
    lineHeight: 1.6
  body:
    fontFamily: "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "16px"
    lineHeight: 1.65
  label:
    fontFamily: "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "15px"
  metadata:
    fontFamily: "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "12px"
    lineHeight: 1.5
  reading:
    fontSize: "16px"
    lineHeight: 1.8
  footer-title:
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  tag: "5px"
  segment: "7px"
  field: "9px"
  action: "10px"
  selector: "11px"
  reading: "12px"
  surface: "14px"
  stage: "16px"
spacing:
  compact: "8px"
  control: "12px"
  inset: "16px"
  mobile-gutter: "20px"
  group: "24px"
  stage: "28px"
  panel: "36px"
  heading-gap: "44px"
  section-mobile: "56px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.studio-green}"
    textColor: "{colors.studio-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.action}"
    padding: "12px 21px"
  button-primary-hover:
    backgroundColor: "{colors.studio-green-hover}"
  button-text:
    backgroundColor: "transparent"
    textColor: "#285c40"
    typography: "{typography.label}"
  input-search:
    backgroundColor: "{colors.studio-paper}"
    textColor: "{colors.studio-muted}"
    rounded: "{rounded.field}"
    padding: "0 12px"
  navigation:
    backgroundColor: "{colors.studio-paper}"
    padding: "12px 40px"
  category-tag:
    backgroundColor: "{colors.category-paper}"
    textColor: "{colors.category-ink}"
    rounded: "{rounded.tag}"
    padding: "3px 7px"
  reading-panel:
    backgroundColor: "{colors.studio-paper}"
    textColor: "{colors.studio-ink}"
    rounded: "{rounded.reading}"
    padding: "30px"
  scenario-selector:
    backgroundColor: "{colors.studio-canvas}"
    rounded: "{rounded.selector}"
    padding: "5px"
  scenario-selected:
    backgroundColor: "{colors.studio-paper}"
    textColor: "{colors.studio-green}"
    rounded: "{rounded.segment}"
    padding: "10px 8px"
  editorial-row:
    backgroundColor: "transparent"
    textColor: "{colors.studio-ink}"
    padding: "30px 0"
---

# Design System: Zentra Studio

## Overview

**Creative North Star: "L’instrument de précision"**

Zentra Studio traduit la direction Apple confirmée par une présentation calme, précise et tactile. Le vert forêt reste l’identité de la famille ; le blanc, le gris perle et l’encre charbon structurent la lecture. La typographie, les séparateurs fins et l’espace font le travail de composition.

Les surfaces ont une fonction lisible : les présentations laissent le contenu ouvert, les documents de démonstration se détachent légèrement, et Support distingue index, liste et lecture. Le contenu métier constitue la matière visuelle. Cette direction a été réalisée dans le code, sans image générée ni composition de référence approuvée.

**Key Characteristics:**

- Une identité verte commune, avec des surfaces blanches et gris perle.
- Une hiérarchie typographique ample dans la présentation, plus compacte dans les outils.
- Des listes éditoriales séparées par des filets, et des contenants réservés aux documents et aux tâches.
- Des exemples explicitement fictifs, des commandes visibles et des états sélectionnés lisibles.

Cette documentation décrit la refonte autorisée, et remplace la direction précédente pour les surfaces Studio. Les valeurs viennent de `app/studio.css`, de l’ordre d’import de `app/layout.tsx` et des règles de composants qui continuent à participer à la cascade. `PRODUCT.md` fixe l’identité, l’accessibilité et la vérité produit ; `.impeccable/surfaces/studio.md` conserve la stratégie propre aux pages.

Périmètre de preuve : `outputs/studio-site-fix2-verdict.md` porte la disposition `ship` pour les quatre corrections revues et les états fournis. Les captures antérieures sont dans `C:/Users/alb/.codex/worktrees/zentra-automation-native-20260920/chantier/outputs/redesign186/fix1/site-*.png`, les derniers états dans `outputs/redesign186/site-states-fix2` du même worktree. Ce document n’ajoute ni session navigateur, ni audit, ni preuve de publication. Les comptes authentifiés, soumissions, paiements, mails réels et distributions natives restent hors de cette preuve.

## Colors

La palette associe un vert forêt dense à des neutres légèrement froids, sans accent secondaire global.

Les rampes du sidecar sont des bandes de visualisation synthétisées en OKLCH à partir des teintes extraites ; elles ne déclarent pas de nouveaux jetons utilisés par le site. Le frontmatter conserve les couleurs CSS normatives.

### Primary

- **Vert forêt** — `studio-green` : actions principales, sélection des dossiers et rappel d’identité dans les titres.
- **Forêt profonde** — `studio-green-hover` : survol du bouton de présentation lorsque le mouvement normal est autorisé.
- **Vert diffus** — `studio-tint` : support du document interactif, sélection des tickets et surfaces de liaison entre produits.
- **Focus produit** — `product-focus` : contour hérité des présentations et du parcours interactif.

### Neutral

- **Papier blanc** — `studio-paper` : pages de présentation, documents et panneaux de lecture.
- **Gris perle** — `studio-canvas` : sections calmes, espace Support, formulaire de compte et sélecteur de scénarios.
- **Encre charbon** — `studio-ink` : texte principal de la famille Studio.
- **Gris de lecture** — `studio-muted` : descriptions et informations complémentaires.
- **Filet doux** — `studio-rule` : séparation des lignes, barres et régions.
- **Étiquette neutre** — `category-paper` et `category-ink` : métadonnées des tickets, sans leur donner le poids d’une action.

**The Forest Action Rule.** Le vert forêt identifie les actions principales et les sélections ; les fonds blancs et gris perle gardent la priorité de lecture.

Les couleurs locales d’erreur ou d’urgence conservent leur sens fonctionnel. Les anciennes teintes ambre du téléchargement et les petites variations de verts héritées ne constituent pas une palette secondaire Studio ; elles ne sont pas généralisées ici.

## Typography

**Display Font:** Geist Sans variable, chargé par `next/font/google` et exposé par `--font-geist-sans`, avec les fallbacks déclarés dans les jetons.

**Body Font:** la même famille dans les présentations et les formulaires.

**Character:** des titres souples et précis, à graisse intermédiaire et approche serrée ; le texte de lecture respire davantage. La rampe est ajustée par rôle et par surface, sans ratio mathématique imposé.

### Hierarchy

- **Display** — `display` : proposition de l’accueil. Le sélecteur de titres du contenu principal impose la hauteur de ligne et l’approche du jeton, même si une règle locale antérieure expose d’autres valeurs.
- **Headline** — `headline` : titres de section des présentations.
- **Title** — `title` : titre du scénario dans la scène compacte ; il devient plus petit sur mobile (26px).
- **Lead** — `lead` : introduction d’accueil, limitée à une ligne de lecture courte (38ch) et réduite sur mobile (17px).
- **Body** — `body` : explications des fonctionnalités. Les FAQ limitent le texte à une largeur confortable (65ch).
- **Reading** — `reading` : texte long de Support et pages juridiques ; la copie juridique est limitée (72ch), les messages Support héritent d’une limite (70ch).
- **Label / Metadata** — `label` et `metadata` : action ou information factuelle, en casse normale.
- **Footer title** — `footer-title` : hiérarchie compacte du pied de page, distincte des grands titres de section.

La navigation globale et `app/support/support.css` conservent une famille système explicite. C’est une différence effective de cascade, pas une nouvelle police d’affichage à prescrire. Geist Mono est chargé, mais aucun rôle typographique global n’est déduit de son seul chargement.

**The One Typographic Lead Rule.** Un titre conduit chaque groupe ; les métadonnées restent discrètes et factuelles, sans surtitre décoratif à reproduire.

## Layout

Le système juxtapose de grandes zones de lecture puis resserre les tâches. Les principales sections réemploient l’espacement `section`, réduit à `section-mobile`. La marge horizontale mobile utilise `mobile-gutter`. Les espacements du frontmatter sont un vocabulaire extrait, pas une obligation de faire entrer chaque dimension dans une grille unique.

L’en-tête et l’entrée d’accueil partagent un plafond large (1360px). L’accueil est une grille asymétrique (0.86fr / 1.14fr), avec un intervalle ample (72px), puis compact (32px) jusqu’au seuil tablette (1100px). Les conteneurs éditoriaux conservent une largeur héritée `min(1144px, calc(100% - 64px))` ; leur `max-width` Studio (1280px) ne supprime pas cette limite de largeur. Ne pas les décrire comme des blocs systématiquement larges de 1280px.

Au seuil mobile (760px), le titre précède la scène, les produits deviennent des lignes empilées, la navigation produit occupe une seconde rangée et les marges internes se réduisent. L’affichage de titre d’accueil utilise alors `clamp(40px, 10vw, 58px)`, avec une mesure courte (11ch). Entre mobile et tablette, sa taille est fixée (52px).

Support distingue une colonne d’index (244px), puis une liste et une lecture séparées par un intervalle (24px). Les deux dernières colonnes utilisent `minmax(280px, .9fr) minmax(0, 1.3fr)`. De tablette à mobile, liste et détail se relaient ; l’index intermédiaire se resserre (212px), puis passe au-dessus du contenu. L’état de lecture mobile masque l’en-tête de liste et ses filtres. Les marges Support prennent en compte les zones sûres de l’appareil.

Le compte garde une colonne d’index distincte (248px). La connexion utilise une scène plus étroite (1080px), et les documents juridiques un plafond de lecture propre (1120px). Ces variantes servent la tâche ; elles ne sont pas des exceptions à corriger automatiquement.

## Elevation & Depth

La profondeur vient d’abord de la séparation des fonds et des filets. Les boutons primaires, les lignes éditoriales, l’installateur et les panneaux Support n’ajoutent pas d’ombre. Les ombres douces soulèvent les exemples de documents ou indiquent une sélection.

### Shadow Vocabulary

- **Document interactif** (`0 16px 36px -20px #173c2940`) : fenêtre de la scène compacte.
- **Aperçu de Gestion** (`0 24px 60px -28px #173a2a33`) : fenêtre produit sur son support.
- **Bilan quotidien** (`0 16px 50px -32px #18362940`) : document de synthèse.
- **Scénario sélectionné** (`0 2px 7px #1836290d`) : segment blanc actif.
- **Onglet de compte sélectionné** (`0 2px 5px #173a2a0d`) : onglet actif du formulaire.

**The Document Depth Rule.** L’ombre signale surtout un document démontré ou une sélection ; les listes éditoriales et les panneaux Support restent sobres et sans ombre ajoutée.

L’en-tête garde une propriété de flou héritée, mais son fond Studio est opaque. Cette déclaration ne justifie pas de présenter le verre translucide comme une matière générale de la refonte.

## Shapes

Les angles sont arrondis selon la fonction : petit rayon pour les étiquettes et segments, rayon intermédiaire pour les champs et actions, rayon plus ouvert pour les surfaces et le support de démonstration. Les tailles exactes se trouvent dans `rounded`. Les lignes éditoriales restent carrées, ouvertes et séparées par un filet fin (1px).

Les cercles du parcours servent les numéros d’étape et l’état terminé. Ils restent des repères de progression ; cette géométrie n’impose pas de boutons pilules partout. Les icônes du produit sont des tracés SVG fonctionnels.

## Components

### Buttons

Des actions calmes, identifiables et assez grandes pour le toucher.

- **Primary:** le bouton de présentation emploie `button-primary`, une hauteur minimale (48px), une flèche SVG et aucun effet de relief.
- **Text:** `button-text` hérite encore d’un vert local ; sa hauteur minimale est conservée (44px) et son survol souligne le lien.
- **Support:** l’action pleine conserve son format opératoire local, avec un rayon de champ, une hauteur minimale (44px) et une marge interne (10px 17px).
- **Hover / Focus:** le bouton principal change de fond ; les présentations utilisent le contour `product-focus` (3px, décalage 4px). Le contour générique Studio est plus fin (2px, décalage 4px). Support conserve un contour bleu local et un focus de recherche vert ; ne pas prétendre que tous les contrôles utilisent un contour identique.
- **Disabled:** les boutons Support passent à une opacité réduite (0.5) et gardent le curseur d’indisponibilité. La présence d’un état visuel ne prouve aucune action serveur.

### Chips

Des métadonnées discrètes, sans surcharge.

- **Category:** `category-tag` identifie une catégorie ou un état ; son texte compact (11px) n’est pas une taille de texte principal.
- **State:** ces étiquettes ne sont pas des commandes. La sélection d’un ticket se lit sur toute sa ligne, avec un fond teinté et un état `aria-pressed`.

### Cards / Containers

Des surfaces utilisées pour lire ou agir.

- **Reading:** `reading-panel` forme la surface blanche de détail Support. Le contenu interne emploie des filets et une hiérarchie, sans empiler des cartes.
- **Demonstration:** un support teinté contient une fenêtre blanche ; son ombre appartient au document, pas à chaque contrôle.
- **Editorial rows:** `editorial-row` associe une icône utile, un titre, une explication et une flèche. Sur mobile, l’explication passe sous le titre ; les liens et les fonctions restent accessibles.
- **Authentication:** le formulaire tient sur une surface gris perle, avec un rayon de surface et une marge interne de panneau, réduite sur mobile (26px 20px).

### Inputs / Fields

Des champs explicites avec une zone de saisie blanche.

- **Search:** `input-search` garde l’icône SVG de recherche, le libellé accessible et une hauteur minimale (46px). Le texte passe de la taille d’action à une taille mobile lisible (16px). Le parent reçoit un contour vert au focus interne (2px, décalage 2px).
- **Authentication:** les champs ont un rayon de champ, une bordure grise locale et des labels persistants. Les placeholders restent secondaires ; le focus interne du groupe reste visible.
- **Errors:** les messages d’échec sont du contenu textuel existant. Cette documentation ne crée ni nouvelle validation ni nouvelle règle d’authentification.

### Navigation

La navigation globale est blanche, continue et collée en haut de page. Ses liens compacts (14px) conservent une zone minimale (44px). Le produit courant est vert et souligné par un filet (2px). Sur mobile, les produits passent sur une rangée entière, tandis que la marque et le compte restent au-dessus.

Support possède un index de dossiers, puis ses vues d’administration. Un dossier choisi est plein vert ; les vues utilisent un fond plus léger. Le retour du détail restaure le focus sur le ticket d’origine. Les dossiers représentent des vues internes : leur apparence ne doit pas suggérer un déplacement du courrier fournisseur.

### Interactive document

Le sélecteur présente trois scénarios, puis trois étapes commandables. Le scénario actif emploie `scenario-selected` sur `scenario-selector`. Changer de scénario revient à la première étape et arrête la lecture. Une action séparée permet d’animer, mettre en pause et rejouer ; le délai du parcours est explicite (2100ms), et la lecture s’arrête lorsque l’onglet devient masqué.

La scène compacte utilise une arrivée courte (380ms) avec `--studio-ease`, une translation verticale légère (8px) et une découpe qui se referme. Les états de présentation ont des transitions brèves (180ms). La préférence de mouvement réduit réduit globalement les durées à presque zéro (0.01ms) ; Support supprime ses animations et transitions. Le parcours conserve ses contrôles et ses informations.

Les mentions de fiction et conditions métier font partie de l’artefact. La démonstration reste illustrative : elle ne simule pas une preuve d’exécution sur des données client. Le panneau interactif du sidecar est un échantillon visuel autonome ; les états métier et la lecture restent implémentés dans React.

## Do's and Don'ts

### Do:

- **Do** reprendre les variables Studio pour les nouvelles surfaces de cette famille et conserver l’identité verte Zentra.
- **Do** séparer le titre, l’explication et l’action par la typographie et l’espace avant d’ajouter un contenant.
- **Do** conserver les libellés de données fictives, les conditions de fonctionnement et les états textuels dans les démonstrations.
- **Do** préserver les commandes clavier, les contours de focus, le retour à la liste et les adaptations de mouvement réduit.
- **Do** garder les termes Projet et Projets, les liens et le sens du contenu métier.

### Don't:

- **Don't** transformer chaque fonctionnalité en carte de même poids ; reprendre les lignes éditoriales quand le contenu forme une liste.
- **Don't** ajouter un surtitre décoratif pour remplir l’espace au-dessus d’un titre.
- **Don't** étendre les accents ambre résiduels ni la police système des titres Support à la nouvelle identité.
- **Don't** utiliser une ombre dure, un halo décoratif ou une image fictive pour remplacer la démonstration du produit.
- **Don't** présenter une maquette interactive ou un verdict visuel comme preuve de publication, d’authentification, de paiement ou de traitement réel des données.

Écarts non canonisés : des accents ambre subsistent dans la page de téléchargement ; des surtitres Support existent encore dans des branches de bienvenue ou de réglages ; les titres Support héritent d’une police système explicite. Ils restent documentés comme héritages locaux, sans réparation dans cette passe et sans promotion en règle du nouveau monde. Le verdict final est borné aux corrections et états fournis ; il ne certifie pas leur absence sur toutes les routes.
