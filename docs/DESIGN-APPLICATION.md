# Interface de Zentra

La refonte de septembre 2026 rapproche l’application des conventions visuelles d’Apple tout en conservant le vert de Zentra. Elle s’applique au shell partagé de l’application, aux formulaires, aux listes et aux commandes des aperçus. Les mises en page imprimées conservent leur propre style.

- Fond neutre `#f5f5f7`, texte `#1d1d1f`, cartes blanches, bordures discrètes et rayons de 22 à 28 pixels.
- Menu latéral clair, sélection blanche mobile entre les destinations et pictogramme vert pour le module courant. L’identité de l’entreprise est regroupée ; les groupes sont séparés par des filets discrets.
- Barre d’outils compacte pour la recherche, le compte et l’aide. Les grands titres se trouvent dans l’en-tête du contenu, à côté de l’action principale. Le dossier d’un projet conserve un titre de premier niveau accessible.
- Les quatre indicateurs de l’accueil sont réunis dans une surface blanche avec séparateurs. Le vert souligne le montant facturé. Les monnaies restent séparées et les montants ne sont pas arrondis pour la présentation.
- Les éléments à suivre sont présentés en lignes, à côté des projets actifs sur grand écran. Sur téléphone, ces sections se suivent verticalement. La préparation d’un devis reste accessible dans l’en-tête.
- Sur téléphone, le pointage et le compte restent accessibles par des boutons compacts avec leurs noms accessibles complets. La navigation inférieure possède une sélection glissante mesurée sur le bouton réel. Le bouton Menu indique aussi la section courante pour les modules secondaires.
- Onglets et étapes regroupés, surfaces de saisie neutres, total et commandes du formulaire toujours accessibles. Aperçus et guide utilisent les mêmes couleurs et arrondis.
- Les transitions utilisent CSS, sans nouvelle bibliothèque, police téléchargée ni image décorative. Les préférences de réduction du mouvement et de la transparence sont respectées.

Le style partagé est défini dans `desktop/src/workspace-shell.css`. Le guide et l’aperçu ont leurs styles dédiés. Les styles historiques de `.eyebrow` ne forcent plus la taille et la couleur avec `!important`.

Les effets officiels AppKit/UIKit déjà présents restent distincts de cette interface HTML/CSS. Leur activation exige le système Apple compatible et une réponse positive du pont natif ; sinon les commandes HTML restent accessibles. Les essais navigateur ne valident pas le rendu natif sur un Mac ou un iPhone physique.

Les [recommandations Apple sur les matériaux](https://developer.apple.com/design/human-interface-guidelines/materials) réservent Liquid Glass à la navigation et aux commandes. Les surfaces de données restent opaques ; la barre d’outils et la navigation mobile utilisent un traitement translucide de repli dans l’interface web.

## Vérification

TypeScript et Vite passent ; 798 tests d’interface passent. Le parcours Apple couvre cinq formats : 1440 × 1000, 1024 × 800, 390 × 844, 320 × 568 et 844 × 390. Il vérifie la navigation, les 16 sujets du guide, sa reprise, la protection de l’écran en arrière-plan et la réduction du mouvement. La création de devis/factures est vérifiée sur quatre formats, avec brouillon conservé, acompte, création rapide d’un client, avoir lié et lecture seule. Les aperçus sont vérifiés sur quatre largeurs avec lecture, mise en page, zoom, export simulé avec reprise après erreur et retour du focus.

La seconde passe vérifie aussi l’alignement de la sélection mobile pour les modules principaux et secondaires. Les parcours du pont natif passent en simulation iOS et macOS : navigation disponible, ancien système et module absent. La navigation reste bloquée derrière un formulaire ou le guide. Il s’agit de simulations du pont, pas d’essais de Liquid Glass sur appareil.

Les captures et rapports locaux se trouvent dans `.qa/apple-interface` (fichiers `refinement-*` pour la seconde passe), `.qa/apple-workspace`, `.qa/document-wizard-edge` et `.qa/design-experience`. Le lint global du grand composant historique `WorkspaceApp.tsx` reste non conforme ; il ne constitue pas une validation acquise. Aucun nouveau binaire natif ni déploiement du site de présentation n’est produit par cette refonte.
