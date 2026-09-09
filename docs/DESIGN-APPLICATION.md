# Interface de Zentra

La refonte de septembre 2026 rapproche l’application des conventions visuelles d’Apple tout en conservant le vert de Zentra. Elle s’applique au shell partagé de l’application, aux formulaires, aux listes et aux commandes des aperçus. Les mises en page imprimées conservent leur propre style.

- Fond neutre `#f5f5f7`, texte `#1d1d1f`, cartes blanches, bordures discrètes et rayons de 22 à 28 pixels.
- Menu latéral clair, sélection blanche mobile entre les destinations, icônes sobres et identité de l’entreprise regroupée.
- Chiffres en premier sur l’accueil. Le bandeau promotionnel est retiré ; la préparation d’un devis est accessible dans l’en-tête. Les monnaies restent séparées et les montants ne sont pas arrondis pour la présentation.
- Sur téléphone, le pointage reste accessible par un bouton compact avec un nom accessible complet. Le compte conserve également son nom accessible lorsque seul son pictogramme est affiché.
- Onglets et étapes regroupés, surfaces de saisie neutres, total et commandes du formulaire toujours accessibles. Aperçus et guide utilisent les mêmes couleurs et arrondis.
- Les transitions utilisent CSS, sans nouvelle bibliothèque, police téléchargée ni image décorative. Les préférences de réduction du mouvement et de la transparence sont respectées.

Le style partagé est défini dans `desktop/src/workspace-shell.css`. Le guide et l’aperçu ont leurs styles dédiés. Les styles historiques de `.eyebrow` ne forcent plus la taille et la couleur avec `!important`.

Les effets officiels AppKit/UIKit déjà présents restent distincts de cette interface HTML/CSS. Leur activation exige le système Apple compatible et une réponse positive du pont natif ; sinon les commandes HTML restent accessibles. Les essais navigateur ne valident pas le rendu natif sur un Mac ou un iPhone physique.

## Vérification

TypeScript et Vite passent ; 798 tests d’interface passent. Le parcours Apple couvre cinq formats : 1440 × 1000, 1024 × 800, 390 × 844, 320 × 568 et 844 × 390. Il vérifie la navigation, les 16 sujets du guide, sa reprise, la protection de l’écran en arrière-plan et la réduction du mouvement. La création de devis/factures est vérifiée sur quatre formats, avec brouillon conservé, acompte, création rapide d’un client, avoir lié et lecture seule. Les aperçus sont vérifiés sur quatre largeurs avec lecture, mise en page, zoom, export simulé avec reprise après erreur et retour du focus.

Les captures et rapports locaux se trouvent dans `.qa/apple-interface`, `.qa/apple-workspace`, `.qa/document-wizard-edge` et `.qa/design-experience`. Le lint global du grand composant historique `WorkspaceApp.tsx` reste non conforme ; il ne constitue pas une validation acquise. Aucun nouveau binaire natif ni déploiement du site de présentation n’est produit par cette refonte.
