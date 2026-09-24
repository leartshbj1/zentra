# Refonte Zentra — direction de travail

## Objectif conservé
Refondre entièrement la présentation du site, de Gestion et de Support. Simplicité, élégance, qualité du détail et continuité entre produits. Conserver la palette verte, les contenus factuels, les fonctions, les droits, les données et les intégrations. Adapter les compositions au mobile et aux apparences de Gestion.

## Direction : précision calme
Une interface comme un instrument bien dessiné : un index stable, une surface de travail, des actions compréhensibles. Le site explique par un parcours interactif ; les applications consacrent leur premier écran au travail. Typographie système dans Gestion (engagement Apple du brief), Geist dans le site, blanc, graphite, gris et vert Zentra. Aucun nouveau chiffre commercial ni témoignage.

Les sept systèmes envisagés avant le tirage : signalétique ferroviaire suisse (orientation), édition contemporaine (lecture), instrument de précision (action), Finder (familiarité), atelier d’architecte (documents), agenda de travail (rythme), catalogue de bibliothèque (recherche). Le tirage 56c39c55 attribue le troisième. Le brief Apple et le choix préalable d’un aperçu interactif priment sur toute expression matérielle incompatible.

Comparaison des contre-propositions du tirage, sur identification du public et clarté produit : spécimen typographique compétitif pour la hiérarchie, moins adapté au travail quotidien ; oscilloscope décliné (vocabulaire technique étranger) mais précision des états retenue ; origami décliné mais progression réversible retenue ; carrière de nuages déclinée mais espace entre groupes retenu ; catalogue de mascottes décliné mais distinction des destinations retenue ; édition à marge centrale déclinée mais rigueur des alignements retenue. Ces disciplines ne changent pas le monde visuel choisi.

## Composition
- Site : proposition à gauche et vrai parcours interactif à droite dès l’accueil ; gamme en lignes éditoriales plutôt qu’en trois cartes équivalentes ; pages produit, compte, connexion et documents cohérents.
- Gestion : index blanc/graphite, panneau actif vert, bande financière horizontale, activité et Automation côte à côte ; paramètres en index + feuille de détail ; listes et formulaires sur surfaces opaques.
- Support : index, liste et lecture séparés ; classement et affectation conservés ; mobile organisé en liste puis détail avec retour.
- Mouvement : arrivée courte de la feuille, changement du document illustratif, états explicites ; réduction du mouvement respectée.

## Vérification et travail restant
Les captures avant/après et les mesures sont dans outputs/redesign186. La première série native ne révèle pas de débordement horizontal aux largeurs 1440, 390 et 320 px. La première série du site a révélé un cache CSS de développement périmé ; elle ne prouve pas le nouveau rendu et doit être remplacée après redémarrage du serveur.

Site : les 19 captures finales sont acceptées par le reviewer, avec disposition `ship` (`outputs/studio-site-fix2-verdict.md` dans le checkout site). DESIGN.md et le sidecar v2 sont générés. La version Sites 252 a été publiée et confirmée `succeeded` le 24 septembre 2026, source cdb1bb456ea0e9abee0eca654f7a366d59a832ae. Elle comprend aussi les optimisations serveur du compte Automation.

Application : les 22 captures du lot 2 confirment la résolution des compositions Comptabilité/Achats et des actions Ventes jusqu’à 320 px. Le reviewer garde `fix` pour une régression localisée à la barre Agenda sur grand écran : les boutons « Aujourd’hui » et « Ajouter » se coupent. Une question utilisateur est ouverte après le budget des deux passes de correction. Les détails et preuves sont dans `outputs/redesign186/native-fix2-verdict.md`. La documentation finale native et les nouveaux installateurs restent à produire ; la version native publique demeure 1.85.1.

Ne pas déclarer la refonte complète terminée avant fermeture de ce reliquat, documentation native et publication vérifiée des paquets. Les 1 646 tests frontend passent ; les corrections de performance du compte sont documentées séparément dans STARTUP-ACCOUNT-OPTIMIZATION-20260924.md.
