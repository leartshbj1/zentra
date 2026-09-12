# Personnaliser les documents Zentra

Dans **Paramètres → Présentation des documents**, ouvrez l’atelier de personnalisation puis choisissez **Factures**, **Devis**, **Bilan** ou **Fiches de salaire**.

Les raccourcis **Logo**, **Titre**, **Introduction**, **Mise en page**, **Conditions / Commentaire** et **Pied de page** ouvrent directement l’outil correspondant. Les trois petites pages du réglage du logo permettent de choisir visuellement sa position.

1. **Style** : partez du modèle Moderne, Classique ou Éditorial. Choisissez la police du document, la couleur, le style et la taille du titre.
2. **Mise en page** : placez le logo à gauche, au centre ou à droite, adaptez sa taille, les marges, l’interligne et le tableau. Pour les documents concernés, placez les totaux avant ou après les conditions.
3. **Textes** : choisissez l’introduction, les conditions ou le pied de page. Sélectionnez des mots pour changer leur police, leur taille, leur couleur, leur surlignage, le gras, l’italique ou le soulignement. Sans sélection, le style choisi s’applique à la suite de votre saisie. Entrée crée une nouvelle ligne ; l’alignement et les puces s’appliquent aux paragraphes sélectionnés.
4. Vérifiez l’aperçu PDF, puis utilisez **Enregistrer les présentations**. **Exporter cet exemple** permet de contrôler un document fictif. **Réutiliser cette présentation** copie les réglages et les textes vers une autre catégorie ; enregistrez ensuite.

Pour rédiger confortablement, ouvrez **Textes → Agrandir l’espace d’écriture**. L’éditeur occupe la largeur disponible ; **Voir le rendu PDF** revient au document. Vous pouvez continuer à changer de zone de texte sans perdre votre rédaction.

Les boutons **Texte normal**, **Titre de section** et **Sous-titre** mettent en forme tout le paragraphe courant, ou les paragraphes sélectionnés. Les titres utilisent 18 points et les sous-titres 12 points ; vous pouvez ensuite ajuster chaque passage.

Le collage depuis Word, Google Docs ou un autre texte de Zentra conserve les mises en forme prises en charge : gras, italique, soulignement, couleurs, surlignage, paragraphes, alignement et listes simples. Les polices sont adaptées à Helvetica, Times ou Courier et les tailles à la plage 8–24 points. Les numéros d’une liste collée deviennent du texte. Décochez **Conserver la mise en forme du texte collé** pour coller du texte seul. Les images, objets incorporés et mises en page complexes ne sont pas importés par ce collage ; le logo se règle dans **Logo**.

Un collage trop long est refusé avec une explication et le texte précédent reste présent. Les limites sont de 5 000 caractères pour l’introduction et les conditions, 180 pour le pied de page mis en forme et 60 paragraphes. **Annuler** permet de retirer tout le dernier collage en une seule fois.

Les polices proposées sont Helvetica, Times et Courier, avec leurs variantes en gras et en italique. La taille d’un passage va de 8 à 24 points. L’option « Du document » rétablit l’héritage des réglages généraux ; « Mixte » signale une sélection comportant différentes polices ou tailles. **Effacer la mise en forme** rétablit le texte normal du passage sélectionné. Les boutons **Annuler** et **Rétablir** permettent de revenir sur les modifications.

Les textes de cet atelier sont des textes modèles pour la catégorie choisie. Les remarques propres au devis ou à la facture restent présentes. Les montants, références et données comptables sont calculés par l’application. Les documents émis et les fiches comptabilisées conservent leur présentation enregistrée.

## Validation de l’extension de typographie du 12 septembre 2026

- Tests des sélections : police et taille d’un passage, conservation des autres mots et paragraphes, héritage, styles mixtes et rejet des valeurs non prises en charge.
- PDF natifs : mélange de polices et tailles, retours à la ligne, pagination des documents longs, pied de page, conservation des totaux et des documents déjà émis.
- Parcours Edge et WebKit à 320, 390 et 1 440 pixels : sélection et saisie avec un style actif, annulation, sauvegarde/rechargement, copie entre les quatre catégories et transmission des réglages à l’export.

Cette extension est incluse dans la préversion Windows 1.58.0, publiée le 12 septembre 2026. Consultez [la note de livraison](RELEASE-WINDOWS-1.58.0.md) pour les vérifications et leurs limites. Aucun nouveau lot macOS, iOS ou Android n’a été publié avec cette version Windows.

## Extension de l’atelier — code local, non publiée

Ajouts suivants : raccourcis vers les éléments de la page, position du logo illustrée, espace d’écriture agrandi, styles de paragraphes et collage avec mise en forme. Correction de la ligne vide parasite après effacement complet du texte.

- 22 tests unitaires : remplacements de sélections, conservation du texte autour, paragraphes, styles, normalisation et limites.
- 8 tests natifs : rendu PDF, polices et couleurs mélangées, pagination longue, logos, valeurs comptables des exemples et absence d’écriture de documents métier pendant l’aperçu.
- Parcours de l’atelier dans Edge et WebKit à 320, 390 et 1 440 pixels : collage, copier-coller interne, styles, annulation, texte seul, refus d’un collage trop long, sauvegarde/rechargement et transmission à l’export des quatre catégories. Le navigateur utilise des PDF natifs de recette et un stockage de test ; il ne modifie pas de dossier client.
- Parcours de non-régression de la composition et de la typographie dans Edge aux trois largeurs ; compilation TypeScript et Vite réussie.
- Vérification visuelle des écrans et des exemples PDF. Aucune installation sur un téléphone physique ni distribution d’un nouvel installateur dans ce lot.

Recette reproductible : `desktop/tests/document-word-journey.mjs`. Les observations locales se trouvent dans `desktop/.qa/document-word/`.
