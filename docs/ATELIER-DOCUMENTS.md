# Personnaliser les documents

Dans **Paramètres → Présentation des documents**, choisir Factures, Devis, Bilan ou Fiches de salaire. **Ouvrir le grand atelier** donne plus de place aux outils et à l’aperçu. Le retour aux paramètres conserve les modifications en cours ; utiliser **Enregistrer** pour les conserver après fermeture de l’application.

1. Choisir un modèle de départ, la police du document et celle du titre. Helvetica, Times, Courier, Inter et Literata sont disponibles ; Inter et Literata sont intégrées aux PDF et fonctionnent hors ligne.
2. Ajuster les couleurs, les marges, l’orientation, les tableaux, la position des totaux et le logo. La recherche « Trouvez votre outil » mène directement au contrôle voulu, en ouvrant sa section avancée si nécessaire. Elle ne modifie aucune valeur.
3. Dans Textes, choisir l’introduction, les conditions/commentaires ou le pied de page. Sélectionner des mots pour changer leur police, leur taille, les mettre en gras, en italique, les souligner ou les colorer. Dans le grand atelier, les listes, styles, espacements, recherche/remplacement et copie de mise en forme sont accessibles avec **Plus d’outils**. Le collage conserve la mise en forme prise en charge.
4. Vérifier le rendu PDF puis enregistrer. Ctrl+S / Commande+S enregistre aussi depuis l’atelier. Une erreur de vérification ou d’enregistrement conserve le travail et propose sa correction. L’export de l’exemple permet de contrôler un document fictif.

Les présentations peuvent être copiées entre catégories et conservées en modèles. Les documents déjà émis gardent leur présentation ; les montants et mentions métier sont calculés par le moteur existant.

## Vérification du 13 septembre 2026

- TypeScript et compilation de production réussis.
- 34 tests ciblés de traduction des recherches en contrôles, historique, validation, composition et édition du texte réussis.
- Parcours Edge et WebKit : 320×568, 390×844, 844×390 et 1440×1000. Les 25 destinations de recherche sont accessibles ; conservation du même éditeur et de son historique lors du passage en grand atelier ; outils essentiels/avancés ; échec et reprise de sauvegarde ; raccourci d’enregistrement ; retour au réglage du logo ; export des quatre catégories ; rechargement des réglages ; absence de débordement horizontal. Le centrage de l’espace d’écriture est contrôlé sur ordinateur.
- Moteur natif : 40 tests du filtre `document_` réussis au premier passage. Le test restant a échoué en écrivant son exemple dans un dossier de recette non créé ; après création du dossier, ce même test est réussi. Cela donne 41 tests natifs réussis, incluant les polices embarquées, les quatre exemples financiers, la pagination et la conservation des montants. Aucun changement du moteur PDF dans cette livraison.
- Les essais de navigateur utilisent les PDF du moteur natif comme fixtures et vérifient les paramètres d’export ; ils ne simulent pas une installation sur un iPhone physique.

Preuves dans `desktop/.qa/document-workbench-*` et `desktop/.qa/workbench-native-pdfs`. Cette amélioration est postérieure à l’installeur Windows 1.61 ; aucun nouvel installeur ni IPA n’a été publié pour elle dans cette étape.
