# Support mobile — premier client, 27 septembre 2026

Le lot est **validé localement**, avec une revue **ship** limitée aux corrections examinées. La publication reste en attente. TypeScript et le build de production final ont réussi après les corrections.

## Périmètre et système conservé

L’adaptation porte sur [application.tsx](../components/support/application.tsx) et [support.css](../app/support/support.css), dans l’espace web Support, en mode **Operate**. [PRODUCT.md](../PRODUCT.md) et [DESIGN.md](../DESIGN.md) restent les autorités : identité verte, index, liste et lecture, surfaces sobres, détails secondaires à la demande. Aucun nouveau monde visuel ni token n’est introduit ; cette passe documentaire ne modifie pas le code.

À **760 px et moins**, recherche et filtres sont initialement repliés derrière « Recherche et filtres ». La liste arrive plus tôt ; la description générale de page est masquée. Les critères de recherche, d’état et de catégorie restent conservés. « Filtres actifs » inclut une catégorie sélectionnée. Échap referme les filtres et rend le focus au bouton d’ouverture sans effacer la recherche ; « Afficher les demandes » permet aussi de revenir à la liste.

L’action affiche « Importer » ou « Connecter » sur téléphone, avec son nom accessible complet conservé. Les boutons gardent une hauteur minimale de 44 px. Le texte final de ces actions est à **14 px**, après correction de la valeur initiale de 13 px ; cette valeur existe déjà dans le système documenté. Les annonces d’accès ou de configuration et les erreurs conservent leurs blocs séparés : seule la description générale est visée par le masquage. La disposition de bureau et la recherche visible au-dessus de 760 px restent conservées.

## Preuves examinées

Le [parcours local](../.qa/support-mobile-focus.mjs) et son [rapport](../.qa/support-mobile-focus/proof.json) confirment **huit cas** : Edge et WebKit × 320/390/768/1440 px, à 900 px de hauteur. La confirmation des huit cas a réussi après les corrections finales. Recherche, filtre d’état, remise à zéro, fermeture par Échap avec saisie/focus conservés, lecture et retour à la liste, ouverture de l’import et absence de débordement horizontal sont exercés. Le premier ticket commence à 465 px à 320 px de largeur et 457 px à 390 px. L’indicateur de catégorie active est également relu dans le code ; le parcours ne teste pas spécifiquement ce choix.

Deux captures ont été ouvertes et comparées au système existant : [WebKit, 390 px](../.qa/support-mobile-focus/webkit-390.png), avec liste prioritaire, filtres repliés et action compacte ; [Edge, 1440 px](../.qa/support-mobile-focus/chromium-1440.png), avec index, recherche, liste et lecture visibles. Les exemples et leur bandeau fictif restent présents.

Le [rapport unique du détecteur](../.qa/support-mobile-detector.json), antérieur à la dernière correction, contient **89 avis** : 33 couleurs, 46 tailles de texte, 10 rayons. Le seul avis ajouté par ce lot concernait 13 px, corrigé à 14 px. Le détecteur n’a pas été relancé ; les autres avis sont préexistants et ne sont ni réparés ni promus en règles de DESIGN par cette passe.

## Limites et suite

La preuve est celle de `/support/demo` locale, en français, sur données fictives. Le parcours bloque les requêtes hors de l’origine locale et adapte la directive CSP de mise à niveau HTTPS au serveur HTTP de test. Il ne prouve ni connexion fournisseur, ni import ou envoi réel, ni session authentifiée de production, ni conformité globale d’accessibilité ou de CSP. Les annonces conditionnelles et erreurs sont conservées dans le code, sans relecture navigateur exhaustive de leurs états.

La QA n’a pas été relancée par cette passe documentaire. La publication doit être confirmée séparément ; aucun déploiement de cette adaptation, appareil réel ou livraison native n’est annoncé.
