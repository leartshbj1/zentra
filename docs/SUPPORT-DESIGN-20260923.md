# Zentra Support — règles de surface

État du 23 septembre 2026. Cette note accompagne une extension de l’interface existante. Elle décrit uniquement la surface Support, sans redéfinir l’identité de Zentra. L’absence préexistante de `DESIGN.md` à la racine est constatée ; sa création reste hors périmètre de cette intervention.

## Overview

L’espace de travail adopte une présentation sobre inspirée des applications Apple : navigation grise, contenu blanc, liste de demandes et lecture détaillée. Le vert Zentra reste l’accent établi. Les titres décrivent le dossier ou l’action en cours, sans accroche commerciale dans la zone de travail.

## Colors

- Accent vert (`#17624d`) pour les actions, icônes de dossiers et repères de focus ; sélection sur fond vert pâle.
- Texte principal presque noir (`#1d1d1f`), texte secondaire gris (`#63636a`), séparateurs discrets (`#e4e4e8`).
- Rail de navigation gris clair (`#f5f5f7`) et zone de lecture blanche. Les états restent nommés en texte, au-delà de leur couleur.

## Typography

La police système (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif) donne une lecture familière sans téléchargement typographique. Les titres de page vont de 24 à 32 px sur grand écran ; le titre de détail est de 24 px. Les champs de recherche et de filtre passent à 16 px sur mobile. Les références et compteurs utilisent des chiffres tabulaires.

## Layout

- Au-delà de 1100 px : rail de 240 px, liste et détail côte à côte ; navigation latérale collante avec défilement propre.
- Entre 761 et 1100 px : rail de 210 px, alternance liste/détail et bouton « Retour à la liste ».
- Jusqu’à 760 px : navigation compacte, dossiers dépliables, sections accessibles horizontalement. En lecture, le titre de dossier et la barre de recherche s’effacent pour donner de la place au message. Les commandes principales offrent une hauteur d’au moins 44 px.
- La barre d’outils réunit recherche par sujet ou numéro, filtre d’état et remise à zéro. Catégorie, état et recherche se combinent.

## Elevation & Depth

La séparation repose sur les fonds et les traits fins. La liste et les cartes n’ajoutent pas d’ombre. Les transitions de couleur restent brèves (140 ms) et disparaissent avec la préférence de mouvement réduit.

## Shapes

Les angles sont légèrement arrondis : 8 px pour les entrées de navigation, 9 px pour les champs de la barre d’outils, 12 px pour les principaux conteneurs. Les messages conservent une largeur de lecture contenue et peuvent revenir à la ligne sur les petites tailles.

## Components

**Dossiers.** « Tous les tickets », « À vérifier », « À reprendre » et « Affectés » ouvrent des vues par état. Les dossiers par catégorie reflètent la catégorie de la décision du ticket ; les catégories secondaires sont réunies dans « Autres dossiers ». Le serveur valide la catégorie et applique son filtre avant la pagination. Ces dossiers sont des vues Zentra : ils ne déplacent aucun message dans les dossiers du fournisseur et ne permettent pas de créer des dossiers personnalisés.

**Liste et lecture.** L’état sélectionné est exposé avec `aria-pressed`. L’ouverture place le focus sur le titre du détail ; le retour restitue le focus à la demande. Le chargement est annoncé et les lignes sont temporairement désactivées pendant la récupération. Un filtre sans résultat présente un état vide adapté.

**Vérification.** Le formulaire reste ouvert pour les tickets non affectés et se replie par défaut uniquement lorsqu’ils sont déjà affectés (`routed`), sous « Modifier le classement ». Il reste soumis aux droits et aux conditions existantes, notamment lecture seule et traitement en cours.

**Import.** Après un import qui retourne un ticket, l’interface réinitialise catégorie, état et recherche, recharge sans filtre puis sélectionne le ticket importé. Cette transition évite de masquer le résultat derrière le dossier précédemment ouvert.

## Do's and Don'ts

- Conserver l’accent vert et les libellés opérationnels français de cette surface.
- Préserver les cibles tactiles, le focus clavier et le retour explicite à la liste.
- Présenter les dossiers comme des catégories de tickets ; ne pas promettre une organisation physique de la boîte mail.
- Garder la vérification accessible et visible lorsqu’une décision reste à prendre.

## Sources et validation

Sources de l’implémentation : `app/support/support.css`, `components/support/application.tsx` et `lib/support/service.ts`. Structure documentaire guidée par la référence Impeccable `reference/document.md`, appliquée ici à une note de surface dans le périmètre autorisé.

Validation de la session : 95 tests Support/Infomaniak réussis, vérification TypeScript et compilation réussies. Le relevé local `.qa/support-design/results.json` confirme les parcours dossiers, recherche, filtres combinés, clavier, vérification et sections, sans débordement horizontal aux largeurs 1440, 820, 390 et 320 px. Il confirme également un import simulé depuis une catégorie, suivi d’un rechargement sans filtre, avec zéro écriture externe. Les captures de contrôle sont conservées dans `.qa/support-design/`.

Ces contrôles portent sur l’implémentation locale et les parcours simulés. Aucun déploiement en production n’est effectué dans cette intervention ; l’API d’une boîte mail externe réelle n’a pas été testée en direct.
