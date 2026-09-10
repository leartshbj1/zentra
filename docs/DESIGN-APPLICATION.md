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

## Navigation et réglages — 10 septembre 2026

Le cadre partagé a une barre d’outils plus basse, un menu latéral gris neutre et des lignes plus compactes. Les titres Devis, Commandes et Factures identifient maintenant directement la liste affichée. La sélection glisse entre les trois onglets de vente sans recréer la navigation. Le mesureur ignore sa propre surface de sélection et diffère les mesures des redimensionnements pour éviter une boucle d’observation.

Les paramètres utilisent un panneau de rubriques persistant à partir de 1101 pixels. En dessous, la liste devient un écran de réglages groupés : une rubrique ouvre sa page, et « Tous les paramètres » revient à la liste avec le focus sur la rubrique quittée. Les huit rubriques, leurs formulaires et les raccourcis de configuration/mise à jour sont conservés. Une rubrique déjà ouverte garde ses saisies et son état local lorsqu’on en consulte une autre, y compris la présentation des documents chargée à la demande.

L’ouverture exclusive des rubriques est aussi gérée explicitement pour les moteurs web anciens qui ne regroupent pas encore les éléments `details`. Le parcours est vérifié après retrait de leur attribut de groupe. Le retour à la liste après un raccourci restaure le focus sur la rubrique effectivement ouverte et conserve les sous-sections déjà dépliées.

Sur téléphone, les devis et factures forment une liste continue. Le nombre de résultats et le classement restent visibles ; « Filtrer et trier » déplie les deux sélecteurs. Refermer cette commande conserve les critères et indique les filtres actifs. Aucun changement n’est apporté aux calculs, au classement chronologique ou aux documents imprimés.

Validation : 798 tests d’interface passent. Le nouveau parcours des paramètres vérifie les huit rubriques, la conservation des brouillons, le retour clavier, les liens vers les mises à jour, les filtres mobiles et la réduction des animations sur cinq formats (1440 × 1000, 1024 × 800, 390 × 844, 320 × 568, 844 × 390). Le parcours de classement vérifie quatre ordres, 32 documents, la pagination et la conservation indépendante du choix pour devis et factures. Les parcours de consultation vérifient les références collées, les documents en EUR et les filtres. Les parcours d’aperçu couvrent quatre formats, les 24 lignes et le QR de paiement, le zoom, l’impression, le texte agrandi et la reprise après une erreur d’export simulée. Le guide complet et les replis de navigation Apple passent également ; le pont Apple reste simulé, sans validation sur matériel physique.

Les preuves de cette passe utilisent le préfixe `.qa/apple-interface/system-*` et le dossier `.qa/apple-settings`. Le lint ciblé des nouveaux composants et TypeScript/Vite passent. La maquette générale des paramètres ne dispose pas du moteur natif de génération d’exemples PDF ; elle ne valide donc pas cette génération. Les contrôles des aperçus de vente sont effectués dans leur parcours dédié. Cette passe modifie le code partagé de l’application ; elle ne distribue pas de nouvel installateur et ne modifie pas le site de présentation.

## Assistant de documents et cohérence des écrans

L’assistant de devis, facture et avoir utilise maintenant un panneau d’étapes à gauche sur ordinateur, avec le titre du brouillon et une indication de progression. Sur téléphone, la progression reste compacte au-dessus du formulaire. Le total et les commandes sont toujours accessibles en bas. Les fenêtres intermédiaires répartissent les champs des prestations sur plusieurs lignes, afin de conserver des prix et quantités lisibles. Un catalogue vide ne présente plus de commandes désactivées ; un catalogue existant conserve sa recherche et son ajout de lignes.

Les projets apparaissent dans une liste continue. Chaque dossier conserve son client, son état, sa rentabilité, ses dates et ses actions. Sur un écran large, les informations financières sont placées à droite ; sur téléphone, elles se suivent et l’ouverture du dossier occupe toute la largeur disponible lorsque nécessaire.

La passe suivante répond au signalement de textes débordant dans Comptabilité. Le conteneur d’onglets multiligne utilise des coins modérés et des libellés centrés ; icônes et textes ont des espaces distincts. La barre comptable utilise une grille plutôt que des bases flexibles qui devenaient des hauteurs de plusieurs centaines de pixels quand la disposition passait en colonne. Les styles sont conservés dans `AccountingScreen.css` afin que le chargement à la demande du module ne rétablisse pas l’ancienne disposition.

Les règles communes autorisent les retours à la ligne dans les boutons et les titres longs. Les actions des en-têtes peuvent passer sur une nouvelle ligne. L’import bancaire n’est plus comprimé dans une colonne trop étroite sur tablette ; les actions de démarrage restent lisibles sur téléphone. La police système Apple est également définie à la racine, pour les fenêtres affichées en dehors du conteneur principal.

Les vérifications utilisent des données synthétiques, y compris un grand livre vide explicitement activé par `designLedger` dans la maquette de test. Elles contrôlent l’interface ; elles ne prouvent ni les écritures du moteur natif, ni la génération native d’exemples PDF, ni une installation sur appareil physique. Les erreurs de pont natif rencontrées dans la maquette restent distinctes des débordements visuels. Aucun installateur ni déploiement du site de présentation n’est produit par cette passe.

Validation finale : 157 dispositions contrôlées, sans débordement horizontal ni commande coupée dans les parcours testés. Le contrôle couvre les 16 destinations principales sur cinq largeurs (320, 390, 768, 1024 et 1440 pixels), les neuf rubriques comptables, puis les sous-rubriques de paie, d’achats et de paramètres sur téléphone et ordinateur. Les mesures incluent les boutons masqués par le débordement d’un conteneur, même si la page elle-même ne défile pas horizontalement. Les 798 tests d’interface et TypeScript/Vite passent ; les parcours de devis/facture, guide, aperçus, coûts des projets et rapprochement bancaire passent également avec leurs données de recette. Les preuves finales sont `.qa/apple-interface/screens-validated.log`, `screens-build-validated.log`, `screens-ui-final.log`, `screens-wizard.log`, `screens-navigation.log` et `screens-bank.log`. Le lint ciblé de `SectionTabs` et des fixtures/parcours modifiés passe ; le lint élargi de `DocumentEditor` conserve quatre signalements sur des lignes existantes (références React, autofocus et conversions FormData).
