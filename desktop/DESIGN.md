---
name: "Zentra Gestion — précision calme"
description: "Système partagé : index stable, feuilles opaques, texte système et actions vertes."
colors:
  work-accent: "#286047"
  work-on-accent: "#ffffff"
  work-selection: "#dde8e2"
  work-accent-dark: "#a3d4b8"
  work-on-accent-dark: "#173323"
  work-selection-dark: "#354b40"
  zen-attention: "#805112"
  zen-attention-dark: "#e3b96e"
  work-canvas: "#f5f6f7"
  work-paper: "#ffffff"
  work-rail: "#ffffff"
  work-soft: "#f0f1f3"
  work-line: "#e0e4e1"
  work-ink: "#202125"
  work-muted: "#62656d"
  work-canvas-dark: "#191a1e"
  work-paper-dark: "#28292e"
  work-rail-dark: "#202125"
  work-soft-dark: "#303238"
  work-line-dark: "#41434a"
  work-ink-dark: "#f3f3f5"
  work-muted-dark: "#b6b9c1"
  field-line-dark: "#53555d"
  field-focus-dark: "#a8dabb"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif'
    fontSize: "clamp(30px, 2.8vw, 38px)"
    fontWeight: 560
    lineHeight: 1.16
    letterSpacing: "-.03em"
  headline-mobile:
    fontSize: "32px"
    fontWeight: 560
    lineHeight: 1.16
    letterSpacing: "-.035em"
  journal-title:
    fontSize: "25px"
    fontWeight: 550
    lineHeight: 1.3
    letterSpacing: "-.025em"
  dialog-title:
    fontSize: "23px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-.025em"
  section-title:
    fontSize: "21px"
    fontWeight: 550
    letterSpacing: "-.02em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
  content:
    fontSize: "14px"
    lineHeight: 1.5
  control:
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.4
    letterSpacing: "-.01em"
  navigation:
    fontSize: "14px"
    fontWeight: 450
    lineHeight: 1.4
  navigation-mobile:
    fontSize: "16px"
    fontWeight: 450
    lineHeight: 1.4
  metadata:
    fontSize: "13px"
    lineHeight: 1.5
  compact-label:
    fontSize: "12px"
  dock-label:
    fontSize: "11px"
  metric:
    fontSize: "clamp(20px, 1.85vw, 29px)"
    fontWeight: 550
    lineHeight: 1.5
    letterSpacing: "-.025em"
  metric-multiple:
    fontSize: "clamp(18px, 1.7vw, 27px)"
    fontWeight: 550
    lineHeight: 1.5
    letterSpacing: "-.025em"
  balance-mobile:
    fontSize: "clamp(28px, 8vw, 36px)"
    fontWeight: 550
    lineHeight: 1.2
    letterSpacing: "-.03em"
rounded:
  flat: "0px"
  step: "6px"
  segment: "7px"
  inset: "8px"
  work-control: "9px"
  mobile-action: "10px"
  segment-group: "11px"
  panel-mobile: "12px"
  work-radius: "14px"
  dialog: "16px"
  dock: "20px"
  circle: "50%"
spacing:
  inset: "4px"
  compact: "8px"
  small: "12px"
  icon-gap: "14px"
  medium: "16px"
  row: "18px"
  group: "20px"
  record: "22px"
  section: "24px"
  panel: "28px"
  columns: "30px"
  page-bottom: "56px"
  work-space: "clamp(24px, 3.6vw, 60px)"
components:
  button-primary:
    backgroundColor: "{colors.work-accent}"
    textColor: "{colors.work-on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.work-control}"
    padding: "11px 17px"
  button-primary-dark:
    backgroundColor: "{colors.work-accent-dark}"
    textColor: "{colors.work-on-accent-dark}"
    rounded: "{rounded.work-control}"
    padding: "11px 17px"
  button-secondary:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.work-control}"
    padding: "11px 17px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.work-accent}"
    rounded: "{rounded.work-control}"
    padding: "11px 17px"
  field:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.work-control}"
    padding: "11px 13px"
  field-dark:
    backgroundColor: "{colors.work-soft-dark}"
    textColor: "{colors.work-ink-dark}"
    rounded: "{rounded.work-control}"
    padding: "11px 13px"
  field-portal:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.work-control}"
    padding: "10px 12px"
  sidebar-item:
    backgroundColor: "transparent"
    textColor: "{colors.work-muted}"
    typography: "{typography.navigation}"
    rounded: "{rounded.work-control}"
    padding: "10px 12px"
  sidebar-item-selected:
    backgroundColor: "{colors.work-accent}"
    textColor: "{colors.work-on-accent}"
    rounded: "{rounded.work-control}"
    padding: "10px 12px"
  destination-selected:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-accent}"
    rounded: "{rounded.segment}"
    padding: "10px 24px"
  filter-selected:
    backgroundColor: "transparent"
    textColor: "{colors.work-accent}"
    rounded: "{rounded.flat}"
    padding: "10px 0"
  content-panel:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.work-radius}"
    padding: "28px"
  content-panel-mobile:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.panel-mobile}"
    padding: "22px 18px"
  dialog:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.dialog}"
  document-step-selected:
    backgroundColor: "{colors.work-paper}"
    textColor: "{colors.work-ink}"
    rounded: "{rounded.step}"
  mobile-navigation:
    backgroundColor: "{colors.work-paper}"
    rounded: "{rounded.dock}"
    padding: "5px"
  mobile-navigation-selected:
    backgroundColor: "{colors.work-selection}"
    textColor: "{colors.work-accent}"
    rounded: "{rounded.work-radius}"
---

# Design System: Zentra Gestion

## Overview

**Creative North Star: "Précision calme"**

Un instrument de travail précis et calme, selon la philosophie Apple explicitement choisie pour Gestion : un index stable, une feuille de travail, des actions reconnaissables. Le blanc et les gris organisent la lecture ; le vert Zentra conserve son rôle d’identité et d’action. La typographie système est une décision du brief, pas un choix provisoire de police.

Les surfaces sont opaques. La hiérarchie repose sur la taille du texte, l’espacement, les séparateurs et la sélection, avec une profondeur limitée aux éléments qui en ont besoin. Les thèmes clair et sombre conservent les mêmes rôles ; les compositions téléphone utilisent des lignes et des contrôles tactiles. Le logo existant reste inchangé.

Cette documentation remplace le précédent état visuel et décrit le code partagé actuel. La composition des écrans appartient au [contrat de surface](.impeccable/surfaces/workspace.md) ; les contraintes produit appartiennent à [PRODUCT.md](PRODUCT.md). Ce relevé de code ne constitue ni une nouvelle revue visuelle, ni une validation native, ni une preuve de publication.

**Key Characteristics:**

- Index distinct, fond perle et feuilles de travail opaques.
- Typographie système, titres mesurés et chiffres tabulaires.
- Sélection verte dans l’index ; segments et filtres plus discrets dans la feuille.
- Groupes de données cohérents, sans multiplication de cartes imbriquées.
- Téléphone, thèmes et mouvement réduit traités dans la même couche partagée.

## Colors

La palette associe un vert forestier, un fond perle, du papier opaque et des niveaux de graphite. Le frontmatter contient les valeurs normatives ; les clés suffixées « -dark » décrivent les remplacements des mêmes propriétés CSS dans le thème sombre.

### Primary

- **Vert Zentra** (work-accent) : actions principales, destination active de l’index, texte des segments sélectionnés et focus. Le premier plan associé (work-on-accent) suit le thème.
- **Vert de sélection doux** (work-selection) : briefing Automation, icônes de contexte et destination mobile active. Il ne remplace pas le remplissage franc de la destination desktop.
- **Ambre d’attention hérité** (zen-attention) : cas Automation demandant une revue ou en échec. Ce rôle sémantique existant n’est pas une seconde couleur décorative.

### Neutral

- **Fond perle / graphite de travail** (work-canvas) : espace autour des feuilles.
- **Papier / graphite relevé** (work-paper) : feuilles, tableaux et dialogues. **Index** (work-rail) : blanc en clair, niveau graphite distinct en sombre.
- **Fond adouci** (work-soft) : recherche et support des segments. **Trait fin** (work-line) : limites et séparateurs.
- **Encre / encre secondaire** (work-ink, work-muted) : lecture principale et contexte.
- **Trait de champ sombre / focus de champ sombre** (field-line-dark, field-focus-dark) : valeurs héritées des champs de la zone de travail, distinctes du trait générique.

Les anciens rôles de surfaces et les neutres Automation sont raccordés aux propriétés work-* dans la fenêtre. Les portails de formulaires reçoivent leurs propres alias. Les couleurs de danger/succès et les variantes de boutons danger/dark restent celles des composants métier existants ; elles ne sont pas redéfinies comme nouvelles couleurs de marque. Les rampes du sidecar sont des aperçus de palette synthétisés, pas des tokens supplémentaires.

**The Functional Color Rule.** Le vert signale une action ou une sélection. Tout statut conserve un libellé ; la couleur ne porte jamais seule son sens.

## Typography

**Interface Font:** -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif. La racine ajoute aussi system-ui avant le dernier repli, notamment pour les portails. Titres et corps partagent cette famille ; aucun caractère de marque additionnel n’est introduit dans Gestion.

La hiérarchie est extraite des sélecteurs réellement appliqués, sans échelle mathématique imposée. Les titres de page sont légers et serrés ; les données restent régulières et alignées.

### Hierarchy

- **Headline / headline-mobile** : titre principal de la feuille, taille fluide sur bureau puis rôle fixe sur téléphone.
- **Journal-title / dialog-title / section-title** : journal Automation, dialogue et groupes de contenu. Les titres de section gardent une interligne contextuelle héritée.
- **Body / content** : saisie et texte courant ; descriptions et journal emploient le rôle de contenu. Les introductions de page ont une largeur maximale de 65ch et une interligne de 1.6.
- **Control / navigation** : actions partagées et index. Control décrit les actions dans la fenêtre ; les portails héritent de leur espacement de lettres. Une destination active conserve le poids hérité 600. La navigation téléphone agrandit le texte.
- **Metadata / compact-label / dock-label** : métadonnées opérationnelles, libellés secondaires et navigation basse. Agenda et Catalogue utilisent metadata ; dates de synthèse, badges et résumés conservent certains rôles compacts. Le filtre de journal passe de 13 à 12px sous 381px : héritage ciblé, pas taille de corps par défaut.
- **Metric / metric-multiple / balance-mobile** : montants de la bande financière et solde téléphone, toujours en chiffres tabulaires.

**The Familiar Type Rule.** Conserver la famille système de Gestion et les chiffres tabulaires pour les montants, les dates et les compteurs. La police du site public ne remplace pas celle de l’application.

## Layout

Le bureau utilise un index de 244px, une barre supérieure de 72px minimum et un contenu sans marge extérieure de fenêtre. La gouttière suit work-space. Le titre a des insets verticaux de 38px puis 30px ; le contenu réserve page-bottom. Les feuilles ordinaires utilisent panel pour leur padding.

Entre 861 et 1200px, l’index passe à 216px et la gouttière à 28px. À 860px et moins, la feuille occupe la largeur disponible ; le menu devient un tiroir de min(320px, 88vw). La barre supérieure descend à 64px minimum et ajoute l’inset sûr supérieur. Le contenu garde au moins 20px de chaque côté, augmentés par les safe areas, et réserve 112px plus l’inset sûr inférieur. Les titres utilisent alors des insets de 28px puis 24px. La couche de viewport mobile conserve ses adaptations de largeur et de clavier.

La navigation basse reste à au moins 10px du bas et 14px des côtés, augmentés par les safe areas. Ses destinations ont 54px minimum. Les actions partagées utilisent un minimum de 42px sur bureau et 44px sur téléphone ; les actions de création et l’index tactile utilisent 48px. La navigation de bureau fait 43px minimum ; la recherche d’index 40px. Il s’agit de minimums : padding et contenu peuvent agrandir le contrôle. Les champs usuels ont 44px minimum ; l’installation initiale conserve 46px.

Les tableaux deviennent des enregistrements lisibles sur téléphone. Les données gardent leurs regroupements et toutes leurs actions ; les informations complémentaires se dévoilent sur demande. Les raccourcis Comptabilité sont des lignes icône–texte–flèche ; l’en-tête de réception fournisseurs place son action sous le texte sur téléphone. Ces compositions appartiennent aux écrans concernés, pas à une grille globale imposée.

Le [contrat de surface](.impeccable/surfaces/workspace.md) conserve les compositions Tableau de bord, Réglages et Automation. Le code place la bande financière sur quatre colonnes au grand format puis deux au format intermédiaire ; Automation et le suivi viennent ensuite. Dans Automation, le journal précède son complément de 238px, qui passe dessous dès 1200px. Les paramètres utilisent un index de 232px et une feuille de détail avant leur empilement. Le mode macOS avec navigation native conserve la maîtrise native des bords ; aucun fonctionnement installé n’est déduit de ces règles CSS.

**The Intrinsic Control Rule.** Les libellés traduits peuvent réorganiser leurs groupes. Une action reste lisible et accessible ; compresser son texte n’est pas une règle de composition. Dans Agenda, la barre et ses groupes reviennent à la ligne ; les groupes peuvent se réduire, mais les boutons gardent leur largeur intrinsèque et leur libellé entier.

## Elevation & Depth

Les feuilles, la barre supérieure et l’index reposent sans ombre. Leur différence de ton et les séparateurs suffisent. Le dock téléphone est opaque, bordé et sans flou. Les segments sélectionnés ont une petite ombre ; les dialogues ont une ombre ambiante et gardent un fond distinct de leur voile arrière.

### Shadow Vocabulary

- **Segment sélectionné** : 0 2px 6px rgb(15 30 23 / 5%), pour les destinations internes sélectionnées.
- **Dialogue clair** : 0 8px 28px rgb(20 24 30 / 8%).
- **Dialogue sombre** : 0 8px 28px rgb(0 0 0 / 20%).
- **Pouce d’interrupteur hérité** : 0 1px 3px #00000026, réservé au petit élément mobile du contrôle Automation.

**The Tonal Depth Rule.** Les feuilles au repos se distinguent par leur ton et leurs séparateurs. La légère ombre des segments marque la sélection ; l’ombre ambiante appartient aux dialogues.

La feuille arrive par un déplacement vertical de 8px pendant 240ms, avec cubic-bezier(.16,1,.3,1). Les actions partagées et la sélection d’index répondent par des transitions de fond/couleur de 140ms ease-out. Ces traitements ne sont activés qu’en l’absence de préférence de mouvement réduit. Le système désactive les animations/transitions descendantes dans la fenêtre quand cette préférence est active.

Des traitements plus anciens subsistent pour les tiroirs, les titres, certains formulaires et Automation : notamment 160ms pour les contrôles Automation et une pression à scale(.98) sur les actions de la fenêtre. Ils sont des héritages contextualisés, pas une nouvelle durée universelle. La couche partagée ne remplace pas toutes les animations des portails.

## Shapes

Les angles distinguent les usages : work-control pour les actions et champs, work-radius pour les feuilles, panel-mobile pour les panneaux génériques téléphone. Les feuilles de détail, le journal Automation et les groupes de l’accueil conservent leurs propres angles de feuille sur téléphone. Les lignes internes restent carrées et sont séparées par un trait.

Les groupes de segments utilisent segment-group, leur segment actif segment. Le stepper documentaire emploie step. Le dialogue utilise dialog, seulement aux deux coins supérieurs sur téléphone ; le dock utilise dock et ses destinations work-radius. Les cercles et pilules restent réservés aux marqueurs et interrupteurs qui les utilisent déjà.

## Components

### Buttons

Des actions explicites, compactes et opaques. Le primaire utilise accent/on-accent ; le secondaire papier/encre avec un trait fin ; le ghost garde un fond transparent et le texte vert. Les tokens indiquent le padding de la fenêtre ; les boutons normaux dans les portails gardent le padding hérité 0 17px. Les tailles et actions métier spécialisées restent contextuelles.

Le primaire s’assombrit au survol compatible pointeur par brightness(.94), sans translation. Le focus partagé utilise un contour d’accent de 2px, décalé de 3px. Un contrôle désactivé a une opacité de 0.55. Les boutons secondaire/ghost n’acquièrent pas automatiquement le filtre du primaire. La pression conserve le traitement hérité décrit dans Elevation & Depth.

Les états vides peuvent exposer une action secondaire lorsque l’action de création principale existe déjà dans la feuille ; le composant supporte ce choix sans supprimer l’opération.

### Chips / filters

Les filtres du journal Automation sont des commandes textuelles, à fond transparent, angles droits et soulignement de 2px lorsqu’ils sont pressés. Leur texte actif utilise l’accent. Conserver aria-pressed. Les badges de statut métier et les compteurs conservent leur signification et leur traitement hérité ; ils ne sont pas tous transformés en filtres.

### Cards / Containers

Les panneaux ordinaires ont un fond papier sans bordure extérieure ni ombre. Padding et angles suivent les tokens desktop/téléphone. Les panneaux imbriqués deviennent des sections carrées avec un séparateur supérieur et sans padding horizontal supplémentaire. Les listes et tableaux partagent leur surface ; les en-têtes de tableau restent papier avec un trait inférieur et le texte secondaire.

**The Shared Sheet Rule.** Regrouper les informations liées dans une feuille, puis utiliser des lignes et des séparateurs à l’intérieur. Ne pas recréer une carte flottante autour de chaque détail.

### Inputs / Fields

Les champs clairs et les portails utilisent le papier opaque ; texte et placeholders suivent les encres de travail, avec une caret verte. Dans la fenêtre, le padding hérité est celui de field. Le portail ordinaire conserve field-portal.

Les sélecteurs sombres spécialisés hérités restent plus spécifiques : les champs texte de la fenêtre utilisent work-soft-dark, field-line-dark, puis field-focus-dark au focus. Ils ne doivent pas être documentés comme identiques au papier des portails. Le focus clavier partagé reste visible. La validation de Field expose son erreur écrite avec role=alert ; désactivation et lecture seule restent contrôlées par les composants existants.

La recherche de journal est intégrée dans une surface adoucie, avec focus de groupe ; sa saisie monte à 16px sur téléphone. Ce n’est pas un champ autonome bordé.

### Navigation

L’index présente des icônes SVG de ligne de 18px et des libellés. La destination active combine remplissage accent, premier plan on-accent et poids renforcé. La destination inactive répond au survol par le fond adouci et l’encre principale. L’ancienne couche mobile de sélection animée est masquée ; le dock utilise une sélection tonale douce.

Ventes, Équipe, Comptabilité et Automation emploient des groupes de segments sur fond adouci ; le segment choisi est papier, texte vert, petite ombre. Les destinations Automation se répartissent en trois colonnes égales sur téléphone, avec des labels réorganisables.

### Dialogues and document steps

En-tête et corps sont opaques dans les deux thèmes. Sur bureau, le dialogue a des insets de 22px 28px pour l’en-tête et de 24px 28px pour le corps ; sur téléphone, l’en-tête passe à 18px 20px et le corps conserve ses insets sûrs. Le titre du dialogue téléphone fait 22px.

L’éditeur documentaire laisse son corps extérieur sans padding afin que l’assistant interne maîtrise le défilement. Le stepper présente l’étape courante sur papier, sans ombre ; ses étapes forment deux colonnes sur téléphone. Les actions de pied restent séparées du contenu. Les détails de lignes et de catalogue s’ouvrent sur demande. Modal gère le focus et son retour ; la couche finale bloque le défilement extérieur tant que le dialogue est présent.

### Automation activity

Le code ouvre Automation sur **Activité**, puis propose **À suivre** et **Réglages**. Le journal complet est le premier contenu de la destination d’activité, avec les événements disponibles pour l’entreprise choisie ; règles et réglages restent séparés. Le briefing latéral complète le journal. Les états de chargement, connexion absente et accès inactif restent explicites. Cette organisation est une décision de cette surface, pas une règle imposée à toutes les pages de Gestion.

Les lignes associent un repère iconographique tonal, du texte factuel et un détail ouvrable. Les réglages utilisent un index et une feuille, avec des sections internes. Ne pas ajouter d’événements, de gains ou de compteurs pour remplir l’espace.

## Do's and Don'ts

### Do:

- **Do** employer ensemble les rôles clair/sombre du système partagé.
- **Do** conserver la typographie système voulue pour Gestion et les chiffres tabulaires.
- **Do** maintenir les libellés, les états réels et le focus clavier visibles.
- **Do** laisser les groupes se réorganiser selon leur contenu et conserver les cibles tactiles.
- **Do** préserver les safe areas, le défilement des dialogues et la réduction du mouvement.
- **Do** garder les documents imprimés, leur identité et leurs couleurs indépendants de la couche écran.
- **Do** distinguer les exceptions héritées des primitives à réutiliser.

### Don't:

- **Don't** réintroduire des panneaux de verre, des dégradés décoratifs ou des indicateurs d’activité inventés dans la feuille de travail.
- **Don't** convertir chaque ligne, paragraphe ou réglage en carte indépendante.
- **Don't** reprendre la petite taille de navigation desktop pour les contrôles tactiles.
- **Don't** remplacer un statut écrit par une couleur ou une icône seule.
- **Don't** comprimer les boutons Agenda ni réduire leurs métadonnées pour faire tenir une rangée ; laisser la barre et ses groupes revenir à la ligne.
- **Don't** présenter cette documentation ou un aperçu navigateur comme une livraison native ou une publication vérifiée.

Source de vérité : [src/workspace-atelier.css](src/workspace-atelier.css), importé en dernier par [src/main.tsx](src/main.tsx), avec les sélecteurs plus spécifiques et propriétés héritées de [src/dark.css](src/dark.css), [src/refined.css](src/refined.css), [src/workspace-shell.css](src/workspace-shell.css), [src/automation-design.css](src/automation-design.css), [src/mobile-air.css](src/mobile-air.css) et [src/mobileViewport.css](src/mobileViewport.css). Les API et l’ordre de navigation sont lus dans [src/ui.tsx](src/ui.tsx), [src/WorkspaceApp.tsx](src/WorkspaceApp.tsx) et [src/AutomationHub.tsx](src/AutomationHub.tsx). Les anciennes valeurs dépassées dans la cascade ne sont pas des alternatives de design. La couche finale est limitée à l’écran ; l’impression garde ses propres règles.

État de référence : le [verdict du lot 3](../outputs/redesign186/native-fix3-verdict.md) rend la disposition ship et clôt le point Agenda ; les autres points résolus restent fermés. La barre et ses groupes peuvent revenir à la ligne, les groupes acceptent min-width: 0, et les boutons conservent flex-shrink: 0 et white-space: nowrap. Les libellés « Aujourd’hui » et « Ajouter » restent entiers sans réduire les métadonnées. Ce verdict concerne la revue de l’interface partagée ; il ne constitue pas une validation native ni une preuve de publication. Cette mise à jour documentaire n’a ajouté aucune capture, QA d’interface, compilation ou modification UI.
