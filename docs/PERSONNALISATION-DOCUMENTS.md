# Personnaliser les documents Zentra

L’atelier est inclus dans la préversion Windows 1.59.0, publiée le 13 septembre 2026. Consultez [la note de livraison](RELEASE-WINDOWS-1.59.0.md) pour ses contrôles et leurs limites. Les réglages précis et le nouvel affichage mobile décrits ci-dessous sont ajoutés au code après cette version ; ils ne sont pas encore dans un nouvel installateur. Cette livraison ne comprend pas de nouveau lot macOS, iOS ou Android.

Dans **Paramètres → Présentation des documents**, ouvrez l’atelier de personnalisation puis choisissez **Factures**, **Devis**, **Bilan** ou **Fiches de salaire**.

## Page, titres et tableaux sur mesure — ajout après 1.59.0

Dans **Mise en page**, choisissez visuellement **Portrait** ou **Paysage**. Les textes et les tableaux se répartissent sur la largeur disponible ; les pages se créent automatiquement. Une section de paiement QR garde sa page A4 verticale, même si le reste de la facture est en paysage. Un titre de section ne reste pas seul en bas d’une page avec ces nouveaux formats. Le bouton **Importer ou changer mon logo** conduit directement au réglage de l’entreprise ; les choix de position et de taille restent dans l’atelier.

Dans **Style → Police du titre**, choisissez une police différente du texte courant, ou **Suivre la police du document**. Les trois familles proposées sont Helvetica, Times et Courier. Les polices personnelles ou téléchargées ne sont pas importées.

Ouvrez **Personnaliser les couleurs du tableau** pour régler le fond et le texte des en-têtes et totaux, le fond des lignes alternées et les traits. L’échantillon montre la combinaison choisie. **Automatique** rétablit la couleur issue de votre présentation ; le texte d’en-tête automatique adapte son contraste au fond. Le fond alterné apparaît avec le choix **Lignes alternées**. Les réglages se copient entre catégories avec **Réutiliser cette présentation** et restent annulables.

Dans **Textes**, sélectionnez un passage puis choisissez **Copier le style**. Sélectionnez ensuite un autre passage dans la même zone et choisissez **Appliquer le style** : police, taille, gras, italique, soulignement, couleur et surlignage sont repris sans changer les mots. Si la source contient plusieurs styles, celui du premier caractère est utilisé. Sans sélection de destination, le style s’applique à la suite de votre saisie. **Annuler** retire cette modification en une fois.

Ces ajouts sont intégrés au code, sans nouvel installateur dans ce lot. La recette `desktop/tests/document-customization-journey.mjs` contrôle les quatre catégories, la conservation des réglages, les exports et l’éditeur à 320, 390, 844 et 1 440 pixels. Les tests PDF natifs contrôlent la pagination, les valeurs imprimées, les polices, la page de paiement et l’enregistrement des réglages. Les anciens modèles sans ces options gardent leur comportement.

## Réglages précis et aperçu mobile — ajout après 1.59.0

Les choix rapides restent disponibles. Pour une valeur intermédiaire, ouvrez **Style → Réglage précis de la typographie**, ou **Mise en page → Réglage précis de la page**. Déplacez un curseur ou utilisez les boutons − et +. La valeur apparaît à côté du réglage ; les menus rapides reprennent aussi la valeur choisie.

- Texte : de 8 à 12 points, par demi-point ; titre : de 18 à 34 points.
- Marges : de 12 à 25 mm, par demi-millimètre ; début du contenu : de 12 à 45 mm. **Suivre les marges** rétablit une marge du haut liée aux marges générales.
- Interligne : de 1,15 à 1,8 ; espace entre les blocs : de 0,5 à 2.
- Hauteur maximale du logo : de 24 à 72 points ; espace sous le logo : de 0 à 36 points. La largeur choisie et les proportions du logo restent respectées.
- Espace dans les lignes du tableau : de 4 à 10 points, par demi-point.

Un déplacement continu d’un curseur s’annule en une seule fois. Les touches fléchées permettent également un réglage précis. Ces mesures peuvent augmenter le nombre de pages : vérifiez l’aperçu avant d’enregistrer.

Sur petit écran, **Mes réglages** et **Mon document** permettent de passer des outils au PDF. La barre reste accessible pendant le défilement et permet d’enregistrer depuis l’aperçu. Le texte, sa mise en forme et les réglages restent présents entre les deux vues. Une erreur de génération du PDF est également affichée dans les réglages, avec les actions de correction. Sur grand écran, les outils et l’aperçu restent côte à côte.

## Outils de l’atelier

Les raccourcis **Logo**, **Titre**, **Introduction**, **Mise en page**, **Conditions / Commentaire** et **Pied de page** ouvrent directement l’outil correspondant. Les trois petites pages du réglage du logo permettent de choisir visuellement sa position.

1. **Style** : partez du modèle Moderne, Classique ou Éditorial. Choisissez la police du document, la couleur, le style et la taille du titre.
2. **Mise en page** : placez le logo à gauche, au centre ou à droite, adaptez sa taille, les marges, l’interligne et le tableau. Pour les documents concernés, placez les totaux avant ou après les conditions.
3. **Textes** : choisissez l’introduction, les conditions ou le pied de page. Sélectionnez des mots pour changer leur police, leur taille, leur couleur, leur surlignage, le gras, l’italique ou le soulignement. Sans sélection, le style choisi s’applique à la suite de votre saisie. Entrée crée une nouvelle ligne ; l’alignement et les puces s’appliquent aux paragraphes sélectionnés.
4. Vérifiez l’aperçu PDF, puis utilisez **Enregistrer les présentations**. **Exporter cet exemple** permet de contrôler un document fictif. **Réutiliser cette présentation** copie les réglages vers une autre catégorie en conservant ses textes. Cochez **Copier aussi les textes** pour remplacer également son introduction, ses conditions ou commentaires et son pied de page ; enregistrez ensuite.

Pour rédiger confortablement, ouvrez **Textes → Agrandir l’espace d’écriture**. L’éditeur occupe la largeur disponible ; **Voir le rendu PDF** revient au document. Vous pouvez continuer à changer de zone de texte sans perdre votre rédaction.

Dans **Mise en page → Ajuster les blocs et les espacements**, vous pouvez aussi :

- aligner le nom et les coordonnées de l’entreprise indépendamment du logo ;
- placer les coordonnées du client ou du collaborateur à gauche, au centre ou à droite ;
- régler l’espace sous le logo, le début du contenu depuis le haut de la page et l’espace entre les blocs ;
- commencer les conditions, ou le commentaire du bilan, sur une nouvelle page. Une zone sans texte n’ajoute pas de page.

Dans **Style → Couleurs du titre et du texte**, le titre et le texte courant peuvent avoir leur propre couleur, indépendante des tableaux. Les passages colorés manuellement et le pied de page gardent leur couleur. Les boutons de couleur automatique permettent de revenir au réglage habituel. Vérifiez toujours la lisibilité sur le fond blanc dans l’aperçu.

La barre du haut donne accès à **Annuler**, **Rétablir**, **Aperçu** et **Enregistrer**. Depuis l’aperçu, **Revenir aux réglages** retrouve les outils. Les options de blocs et d’espacement sont disponibles dans Windows 1.59.0.

Les boutons **Texte normal**, **Titre de section** et **Sous-titre** mettent en forme tout le paragraphe courant, ou les paragraphes sélectionnés. Les titres utilisent 18 points et les sous-titres 12 points ; vous pouvez ensuite ajuster chaque passage.

Le collage depuis Word, Google Docs ou un autre texte de Zentra conserve les mises en forme prises en charge : gras, italique, soulignement, couleurs, surlignage, paragraphes, alignement et listes simples. Les polices sont adaptées à Helvetica, Times ou Courier et les tailles à la plage 8–24 points. Les numéros d’une liste collée deviennent du texte. Décochez **Conserver la mise en forme du texte collé** pour coller du texte seul. Les images, objets incorporés et mises en page complexes ne sont pas importés par ce collage ; le logo se règle dans **Logo**.

Un collage trop long est refusé avec une explication et le texte précédent reste présent. Les limites sont de 5 000 caractères pour l’introduction et les conditions, 180 pour le pied de page mis en forme et 60 paragraphes. **Annuler** permet de retirer tout le dernier collage en une seule fois.

Les polices proposées sont Helvetica, Times et Courier, avec leurs variantes en gras et en italique. La taille d’un passage va de 8 à 24 points. L’option « Du document » rétablit l’héritage des réglages généraux ; « Mixte » signale une sélection comportant différentes polices ou tailles. **Effacer la mise en forme** rétablit le texte normal du passage sélectionné. Les boutons **Annuler** et **Rétablir** permettent de revenir sur les modifications.

Les textes de cet atelier sont des textes modèles pour la catégorie choisie. Les remarques propres au devis ou à la facture restent présentes. Les montants, références et données comptables sont calculés par l’application. Les documents émis et les fiches comptabilisées conservent leur présentation enregistrée.

## Enregistrer et corriger un problème

**Enregistrer** vérifie les quatre présentations, y compris celles qui ne sont pas affichées. Si un point demande une correction, l’atelier indique la catégorie et la zone : introduction, conditions, commentaire ou pied de page. Vos réglages restent présents.

**Corriger ce passage** ouvre le bon texte. Lorsqu’un caractère ne peut pas être imprimé avec les polices proposées, il est sélectionné : tapez son remplacement puis enregistrez à nouveau. Pour un pied de page trop haut, raccourcissez le texte ou réduisez la taille des caractères. Pour un logo introuvable, **Ouvrir Entreprise et facturation** conduit au bouton d’import du logo ; revenez ensuite à Présentation des documents.

Si les réglages changent ailleurs pendant la vérification, l’atelier conserve leur état actuel et vous demande de vérifier à nouveau. Il n’enregistre pas l’ancienne copie.

Après un enregistrement réussi suivi d’une lecture interrompue, la fenêtre **Enregistrement effectué** propose **Actualiser les données**. Cette action relit les données enregistrées sans répéter leur sauvegarde. Une nouvelle erreur de lecture garde la fenêtre ouverte et permet de réessayer. Un refus de sauvegarde conserve les textes et les réglages à corriger.

En lecture seule, les présentations et les paramètres restent consultables. Leur modification et la restauration sont désactivées ; les exports JSON/CSV et la création d’une sauvegarde manuelle restent accessibles.

## Retrouver et modifier un passage

Dans **Textes**, ouvrez **Rechercher et remplacer**. Sur ordinateur, Ctrl+F ou Cmd+F depuis le texte ouvre aussi cet outil. La recherche concerne uniquement la zone affichée : introduction, conditions/commentaire ou pied de page.

Saisissez un mot ou une phrase. Les flèches parcourent les résultats ; touchez l’extrait pour sélectionner le passage dans le texte. L’option **Respecter les majuscules et minuscules** affine la recherche. Indiquez le nouveau texte puis choisissez **Remplacer ce résultat** ou **Tout remplacer**. Un remplacement vide supprime le passage. Le style du premier caractère trouvé est repris et le texte autour reste en place.

**Annuler la modification du texte** retire tous les remplacements du dernier clic en une fois. Si le résultat dépasse la place autorisée, aucun remplacement n’est appliqué : raccourcissez le nouveau texte puis réessayez. Échap ferme la recherche.

## Réutiliser ou recommencer sans perdre ses textes

La copie vers une autre catégorie et **Revenir au style de départ** conservent ses textes par défaut. Pour effacer aussi les textes modèles au moment de réinitialiser, cochez l’option correspondante. Ces changements restent annulables dans la barre **Annuler / Rétablir** de l’atelier.

L’historique de présentation concerne les catégories modifiées. Il conserve les autres réglages de l’entreprise actualisés entre-temps. Si la même présentation a été actualisée ailleurs, l’atelier la conserve et explique pourquoi l’ancien historique ne peut plus être appliqué. Après un changement de texte par cet historique, l’historique interne de l’éditeur est remis à zéro pour éviter de réintroduire l’ancien texte.

La recherche, la copie et l’annulation sont disponibles dans Windows 1.59.0.

## Validation de l’extension de typographie du 12 septembre 2026

- Tests des sélections : police et taille d’un passage, conservation des autres mots et paragraphes, héritage, styles mixtes et rejet des valeurs non prises en charge.
- PDF natifs : mélange de polices et tailles, retours à la ligne, pagination des documents longs, pied de page, conservation des totaux et des documents déjà émis.
- Parcours Edge et WebKit à 320, 390 et 1 440 pixels : sélection et saisie avec un style actif, annulation, sauvegarde/rechargement, copie entre les quatre catégories et transmission des réglages à l’export.

Cette extension est incluse dans la préversion Windows 1.58.0, publiée le 12 septembre 2026. Consultez [la note de livraison](RELEASE-WINDOWS-1.58.0.md) pour les vérifications et leurs limites. Aucun nouveau lot macOS, iOS ou Android n’a été publié avec cette version Windows.

## Validation initiale de l’extension de l’atelier

Ajouts suivants : raccourcis vers les éléments de la page, position du logo illustrée, espace d’écriture agrandi, styles de paragraphes et collage avec mise en forme. Correction de la ligne vide parasite après effacement complet du texte.

- 22 tests unitaires : remplacements de sélections, conservation du texte autour, paragraphes, styles, normalisation et limites.
- 8 tests natifs : rendu PDF, polices et couleurs mélangées, pagination longue, logos, valeurs comptables des exemples et absence d’écriture de documents métier pendant l’aperçu.
- Parcours de l’atelier dans Edge et WebKit à 320, 390 et 1 440 pixels : collage, copier-coller interne, styles, annulation, texte seul, refus d’un collage trop long, sauvegarde/rechargement et transmission à l’export des quatre catégories. Le navigateur utilise des PDF natifs de recette et un stockage de test ; il ne modifie pas de dossier client.
- Parcours de non-régression de la composition et de la typographie dans Edge aux trois largeurs ; compilation TypeScript et Vite réussie.
- Vérification visuelle des écrans et des exemples PDF. Aucune installation sur un téléphone physique ni distribution d’un nouvel installateur dans ce lot.

Recette reproductible : `desktop/tests/document-word-journey.mjs`. Les observations locales se trouvent dans `desktop/.qa/document-word/`.
