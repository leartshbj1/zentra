# Extension du site Zentra — 24 septembre 2026

Cette extension rend le parcours entre Gestion, Support et Automation plus lisible dans le monde visuel Studio existant : accueil centré, exemple contrôlable, choix du produit et navigation commune. Elle conserve l'identité verte, les surfaces blanches et gris perle, les lignes éditoriales et les actions Studio. Aucun nouveau monde visuel ni raster produit n'est créé.

## Réalisation

| Fichier | Rôle |
| --- | --- |
| `components/home-experience.tsx` | Introduction, trois scénarios illustratifs, sélection par besoin |
| `components/products-home.tsx` | Assemblage de l'accueil avec gamme, pack, présentation Automation et FAQ existants |
| `components/site-header.tsx` | Menu universel, raccourcis, navigation produit et fermeture accessible |
| `app/intuitive-site.css` | Composition, adaptation mobile et mouvement de cette extension |
| `app/layout.tsx` | Import de la feuille après `studio.css` |

L'accueil mène vers « Voir Zentra à l’œuvre » et « Trouver mon outil ». Le premier contrôle rejoint l'exemple, place le focus sur sa commande de lecture et démarre la progression. Le second rejoint le choix par besoin. Le document et son explication sont côte à côte sur grand écran, puis empilés sur téléphone. Les textes des trois sélecteurs peuvent revenir à la ligne dans leur rangée sans imposer un défilement horizontal.

Les trois exemples portent une mention de données fictives : facture fournisseur vers les achats de Gestion, rendez-vous vers l'agenda de Gestion, demande de facturation vers l'équipe Support. Chacun montre réception, reconnaissance puis destination. Les conditions de connexion, de règles et de contrôle restent accessibles sous l'exemple.

La lecture est volontaire, avec un délai de 1900ms par étape et arrêt au résultat. Pause, relance, étapes directes et « Voir la suite » donnent le contrôle. Changer d'exemple revient à la réception et arrête la lecture ; masquer l'onglet arrête aussi la lecture. La correction de continuité clavier conserve le sous-arbre d'explication : le premier appui sur Entrée garde le focus sur « Voir la suite », le dernier le transfère au lien « Découvrir Automation ». Le document démontré peut toujours être réanimé indépendamment.

Le sélecteur « Commencez par ce qui compte pour vous » propose Gestion, Support, Automation ou Complet. Il conserve les prix affichés dans `PRODUCT.md` (dès 49, dès 29, 15 par entreprise et dès 79 CHF/mois), les dépendances d'Automation et les conditions de l'essai Complet. Les actions rejoignent les routes existantes de démo, d'activation ou de formules ; aucun abonnement n'est créé par le sélecteur.

Le menu universel propose les quatre produits et les accès directs aux démos, packs, téléchargement et espace Support. La navigation contextuelle de chaque produit reste disponible. Sous 760px, la marque, le compte et le bouton menu tiennent sur une rangée. Les menus se ferment avec Échap (focus rendu au bouton), sélection d'un lien, clic extérieur, sortie du focus de l'en-tête ou changement de route. Ouvrir un menu ferme l'autre.

Les nouveaux mouvements utilisent l'easing Studio : arrivée du document et du résultat (400ms), ouverture du menu (320ms), progression discrète. La préférence de mouvement réduit supprime ces arrivées et les nouvelles transitions de progression et de flèche ; le défilement lancé par le bouton devient immédiat. Les états et commandes restent accessibles.

## Comparaison au système établi

`PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, le brief de surface et les cinq fichiers de réalisation ont été lus pour cette passe. La palette, les boutons et l'easing Studio sont réutilisés. L'extension donne une composition locale à l'accueil ; les descriptifs anciens de grille asymétrique, deuxième rangée de navigation mobile et délai de 2100ms dans le système ne décrivent pas ce nouveau parcours de 1900ms. La distinction est enregistrée dans le brief sans modifier les fichiers normatifs.

Le détecteur fourni contient **29 avis**, dont 27 tailles hors de la rampe et 2 couleurs locales, sans constat non consultatif. Les exemples comprennent le plafond du titre à 76px, des tailles de métadonnées et des variations de couleur d'ombre/bordure. Ces avis ne valent pas une conformité complète aux jetons. Ils n'ont pas été effacés en réécrivant `DESIGN.md` ou le sidecar. La hauteur de ligne et l'approche du titre continuent notamment d'être imposées par le sélecteur Studio `body main#contenu h1`, plus spécifique que la règle locale.

`DESIGN.md` signale déjà des héritages locaux : accents ambre du téléchargement, surtitres dans certaines branches Support et titres Support en police système. Cette passe les rapporte sans les réauditer ni les réparer. Aucun changement global de tokens, de police ou de palette n'est déduit de cette extension.

## Preuves vérifiées

Répertoire : `.impeccable/review/magic/`.

| Preuve | Résultat / portée |
| --- | --- |
| `checks-edge.json` | 78 contrôles réussis, `failures: []` |
| `checks-webkit.json` | 78 contrôles réussis, `failures: []` |
| `home-{1440,768,390,320}.png`, `hero-{1440,768,390,320}.png` | Captures d'accueil aux quatre largeurs |
| `menu-{1440,390}.png`, `result-desktop.png`, `finder-desktop.png` | Menu, résultat du parcours et sélecteur de produit |
| `{support,automation,complet}-{1440,390}.png` | États des pages produit conservés dans le dossier de revue |
| `detector.json` | 29 avis : 27 de typographie, 2 de couleur ; aucun non consultatif |

Les 156 assertions vérifient l'absence de débordement aux quatre largeurs, les liens du menu universel, Échap et restitution du focus, les trois scénarios et leurs étapes, pause/lecture, les quatre choix du sélecteur, le mouvement réduit, la fermeture sur lien de la page courante et les deux assertions clavier ajoutées après correction. Les pages `/gestion`, `/support`, `/automation`, `/complet`, `/download`, `/connexion` et `/support/connexions` sont incluses dans les contrôles de largeur ; les menus contextuels sont contrôlés aux largeurs réduites quand ils existent.

Pour la comparaison documentaire, les captures `hero-1440.png`, `hero-768.png`, `hero-320.png`, `home-390.png`, `menu-390.png` et `finder-desktop.png` ont été ouvertes. Le relecteur de finition a confirmé les 18 captures du dossier de revue utilisées pour son évaluation et la composition inchangée après la correction clavier.

Le verdict final communiqué par le relecteur est **`ship`**, avec l'unique correction listée « keyboard continuity » **résolue**. Sa portée est celle du verdict sur cette correction ; il ne constitue pas une nouvelle revue générale du site. Aucun résultat de publication n'est établi par ce rapport.

La vérification WebKit a utilisé un aperçu HTTP local dont le harnais de test retire l'en-tête CSP reçu afin d'éviter la mise à niveau `upgrade-insecure-requests` vers un serveur HTTPS local inexistant. Le CSP de production n'a pas été modifié. Cette preuve provient de WebKit automatisé, pas de Safari sur un iPhone physique. Les captures et contrôles locaux ne prouvent ni un déploiement, ni des connexions de services, ni une exécution sur des données client.

## Limites de préservation

- Conserver les prix, routes et destinations, sens du contenu, données, règles métier, permissions, société sélectionnée, authentification, abonnements, paiements et intégrations ; conserver les termes Projet/Projets.
- Garder les exemples explicitement fictifs, leurs conditions et les cas incertains à vérifier. N'ajouter ni gain chiffré garanti, ni client ou témoignage inventé.
- Les parcours e-mail nécessitent Support et Gestion reliés à la même entreprise, une connexion compatible et les règles activées. Aucun envoi automatique de réponse, remboursement ou paiement bancaire n'est ajouté. Le planificateur toutes-applications-fermées n'est pas activé par cette présentation.
- La passe documentaire écrit seulement `.impeccable/surfaces/intuitive-site.md` et ce rapport. Elle ne modifie ni code source, ni dépendance, ni système visuel normatif et n'effectue aucun déploiement. Les PNG sont des preuves locales, pas de nouveaux assets du produit.
