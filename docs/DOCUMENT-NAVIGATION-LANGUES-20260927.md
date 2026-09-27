# Navigation de l’atelier de documents — 27 septembre 2026

Lot postérieur au gel de **1.90.5**, non inclus dans l’installateur actuellement publié. Il avance la couverture multilingue du point 13 ; il ne clôt pas tous les outils avancés.

## Changement

La recherche des 25 outils accepte maintenant le vocabulaire de la langue choisie, ainsi que les termes français historiques. Les accents, majuscules et recherches à plusieurs mots sont pris en charge. Les résultats, descriptions, zones du document et commandes du grand atelier sont traduits en allemand suisse, italien et anglais. Les cibles, valeurs, textes du client et calculs restent inchangés. Le bilan conserve ses exclusions destinataire/totaux ; son commentaire accepte aussi le vocabulaire de mise en forme localisé.

La fermeture du grand atelier restitue le focus au bouton d’ouverture après son remontage par React, y compris sur mobile. La zone défilante mobile réserve la hauteur de sa barre fixe lors du repositionnement de la recherche.

## Vérifications exécutées

- Suite générale avant la correction finale de focus : **1 805 tests / 221 fichiers**, tous réussis, `desktop/.qa/document-navigation-all-unit.log`.
- Suite finale ciblée : **15 tests**, recherche et catalogue de langue, réussis, `desktop/.qa/document-navigation-final-unit.log`. TypeScript final sans erreur et build Vite réussi ; journaux `document-navigation-tsc.log` / `document-navigation-build.log`.
- **16 parcours navigateur finaux**, Edge et WebKit, 320 et 1 440 px, FR/DE/IT/EN. Chaque parcours vérifie les 25 liens réels vers les contrôles, soit 400 navigations. Entrée, flèche bas, Échap, effacement, résultat vide, menu des zones, retour aux paramètres et conservation de la police choisie sont contrôlés.
- Le mobile est contrôlé en sombre puis en clair ; le bureau en clair. Aucun débordement horizontal ni texte de résultat coupé dans ces tailles. Le scénario utilise les vrais composants et styles de Paramètres, avec données métier et génération PDF substituées uniquement dans le banc d’essai.
- Preuve finale : `desktop/.qa/document-navigation-languages/proof.json`. Captures allemandes bureau/mobile relues après correction ; titres localisés et recherche visible sous la barre fixe. Le premier essai avait omis d’ouvrir le menu des zones, puis la recette a révélé le défaut réel de restitution du focus. Les états de recette intermédiaires ne sont pas des validations finales.

## Limites

À la livraison de ce lot, les commandes internes avancées, certains contrôles et erreurs de l’éditeur restaient à traduire. Le [lot suivant](DOCUMENT-EDITOR-LANGUES-20260927.md) les complète et ajoute un essai à 200 %, avec ses propres limites. Le contenu des PDF et l’export natif n’ont pas été validés à nouveau dans le présent lot. Pas d’iPhone physique ni d’essai à 200 % dans ces 16 parcours de navigation initiaux. Les paquets natifs publics restent 1.90.5. Le build signale toujours des fragments JavaScript de plus de 500 ko ; aucune optimisation de poids ni performance serveur n’est attribuée à ce changement.

Le langage visuel Operate existant est conservé. Revue finale manuelle du diff, des parcours, du retour clavier et des captures ; aucune nouvelle direction graphique ni règle de marque.
