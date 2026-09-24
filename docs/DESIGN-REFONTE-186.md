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

## Vérification et livraison
Les captures avant/après et les mesures sont dans outputs/redesign186. La première série native ne révèle pas de débordement horizontal aux largeurs 1440, 390 et 320 px. La série finale du site remplace les premières captures affectées par un cache CSS de développement périmé.

Site : les 19 captures finales sont acceptées par le reviewer, avec disposition `ship` (`outputs/studio-site-fix2-verdict.md` dans le checkout site). DESIGN.md et le sidecar v2 sont générés. La version Sites 252 a été publiée et confirmée `succeeded` le 24 septembre 2026, source cdb1bb456ea0e9abee0eca654f7a366d59a832ae. Elle comprend aussi les optimisations serveur du compte Automation.

Application : les 22 captures du lot 2 confirment la résolution des compositions Comptabilité/Achats et des actions Ventes jusqu’à 320 px. Le reliquat de la barre Agenda repéré dans `outputs/redesign186/native-fix2-verdict.md` a été corrigé après la reprise explicite de l’utilisateur. La documentation native `desktop/DESIGN.md` et son sidecar v2 reflètent la cascade finale.

Après la demande explicite « Corrige tout et publie en ligne », le troisième lot ciblé ferme ce reliquat : les groupes de la barre Agenda reviennent à la ligne, sans comprimer les boutons. Les quatre captures 1440/390, clair/sombre, sont acceptées par le même reviewer dans `outputs/redesign186/native-fix3-verdict.md`, disposition `ship`, dernier point `resolved`. Le documenter a actualisé les deux fichiers de design. La liste des six corrections est maintenant fermée à la portée des captures fournies.

Les contrôles natifs ont ensuite révélé deux défauts mobiles : marges de sécurité écrasées par la nouvelle cascade, et ancien fond de survol sombre associé au nouveau texte foncé. Les deux sont corrigés dans la version 1.86.1. Les 141 cas d’affichage passent sous Edge et WebKit, sans débordement ni contraste insuffisant dans les écrans contrôlés ; le retour clair/sombre restaure les couleurs. Les parcours tactiles passent aux trois formats, et les 42 scénarios de compte/entreprise passent dans WebKit.

Les paquets 1.86.1 proviennent tous de `88d1d741afdb0fd1691b6419f1c476bbada2a961`. Ils sont publiés avec leurs empreintes vérifiées ; les canaux Windows et Mac sont promus. Windows est installé et testé sur le PC, Mac lancé et relancé dans un profil isolé sur macOS. L’IPA et l’APK sont compilés et contrôlés, sans test sur appareil physique ni publication en boutique. Voir RELEASE-1861-20260924.md et `outputs/release1861-final/delivery-audit.json`. Les corrections de performance sont détaillées dans STARTUP-ACCOUNT-OPTIMIZATION-20260924.md.
