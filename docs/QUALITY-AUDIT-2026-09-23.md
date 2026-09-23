# Audit de qualité — Zentra Gestion

Audit du 23 septembre 2026, sur la version source 1.84.0 et les corrections de la branche `codex/app-quality-audit-20260923`.

## Périmètre et références

Application Gestion, espace Automation, menus, douze rubriques des paramètres, création et lecture de documents. Contrôles du moteur Rust et du serveur partagé. Les manipulations de l’interface utilisent uniquement les données fictives du harnais mobile ; aucune entreprise réelle, facture client, boîte mail ou facturation Stripe n’a été modifiée.

Source native de départ : `60d80c757e7ccca9e8e541cba8777f24b35e47a1`.
Source serveur testée, dans son checkout indépendant : `16c2809c8f8df17ee165268d44982ee7f0c9b61b`.

Références visuelles consultées :

- [Apple — Typography](https://developer.apple.com/design/human-interface-guidelines/typography) : lisibilité, tailles de texte et adaptation du contenu.
- [Linear — Behind the latest design refresh](https://linear.app/now/behind-the-latest-design-refresh) : navigation discrète, hiérarchie claire et réduction du bruit visuel.

L’identité validée par l’utilisateur est conservée. Ces références guident la lisibilité ; elles ne justifient aucune promesse de composants Apple natifs.

## Défauts corrigés

| Défaut constaté | Correction |
| --- | --- |
| Titre et chiffres des Relances blancs sur une carte blanche en mode clair | Suppression de l’ancien décor sombre et utilisation des couleurs sémantiques de texte, surface et séparateurs. Mode sombre vérifié séparément. |
| « Vérification » coupé dans les quatre étapes du devis à 320 px | Progression sur deux colonnes jusqu’à 480 px ; tous les intitulés restent accessibles et les boutons gardent une hauteur minimale de 44 px. |
| Textes secondaires trop pâles dans l’accueil, les projets, l’agenda et les paramètres | Couleurs sémantiques adaptées au thème ; contraste renforcé des badges, compteurs et unités monétaires. |
| Icônes multicolores dans les réglages, incohérentes avec les nouveaux menus | Icônes sobres et couleur de sélection commune, en clair et en sombre. |
| Texte minuscule et titre/statut serrés dans la préparation de l’entreprise | Texte d’aide agrandi et retour à la ligne des titres et statuts. |
| Formulaire de devis/facture restant en français dans une interface allemande | Textes, étapes, titres, champs, confirmation et erreurs de saisie reliés au catalogue français/allemand/italien/anglais. |
| Message d’erreur incluant le mot « obligatoire » dans le nom du champ | Extraction du nom du champ seul ; focus conservé sur le champ à corriger. |
| Risque de perdre la cible de focus après traduction des libellés de ligne | Recherche du champ avec son libellé traduit ; identifiant métier du champ conservé. |
| Chiffre d’affaires mobile non traduit | Traduction de ce libellé dans les trois autres langues. |

La langue de l’interface ne transforme ni les noms des clients, ni les descriptions, notes, unités enregistrées, montants, taux, identifiants ou données persistées. Aucun changement de calcul financier, de droits ou de synchronisation réseau.

## Résultats automatisés

| Contrôle | Résultat |
| --- | --- |
| Interface, dernière suite complète | **1 630 réussis**, 0 échec, dans 200 fichiers |
| Moteur natif Windows, suite complète | **754 réussis**, 0 échec, 3 explicitement ignorés par la suite |
| Contrôle HTTPS natif supplémentaire | **1 réussi** : connexion TLS au service de licence avec un faux jeton, correctement refusé |
| Serveur partagé, suite complète puis reprises ciblées | **1 475 cas distincts réussis**, 63 conditionnels non exécutés |
| TypeScript | Vérification sans erreur |
| Construction web de production | Réussie ; modules lourds conservés en chargement différé |
| Exécutable Windows final | Compilation réussie, démarrage et réouverture dans une base isolée, intégrité SQLite correcte, aucune erreur de clé étrangère |

La première exécution serveur a donné 1 464 réussites et 11 échecs pendant l’exécution simultanée des grandes suites. Les quatre fichiers concernés ont été rejoués avec moins de concurrence : 17 + 181 tests réussis, couvrant les onze échecs. Leurs durées initiales correspondaient aux limites de temps et se sont fortement réduites à la reprise. Cela indique une contention du poste de test ; ce n’est pas une mesure de capacité du serveur de production.

Les contrôles couvrent notamment les centimes exacts, TVA, acomptes et avoirs, encaissements/reprises, comptabilité fournisseurs, règles salariales, sauvegardes/restaurations, conflits, écritures concurrentes, reprise de synchronisation et isolation entre entreprises. Les quatre nouveaux cas de régression vérifient que les langues ne changent pas les nombres acceptés, les limites numériques et les calculs en centimes.

Les 63 cas serveur non exécutés nécessitent des fixtures d’interopérabilité supplémentaires. Parmi les trois tests natifs ignorés, celui de TLS a été exécuté séparément ; les deux autres nécessitent des copies de données explicitement fournies ou des autorisations de sauvegarde dans une entreprise de recette. Ils ne sont pas comptés comme réussis.

## Vérifications interactives

- Dix-sept écrans parcourus : accueil, Automation, agenda, projets, clients, catalogue, devis, factures, relances, temps, équipe/paie, achats/fournisseurs, banque, rapports, comptabilité, paramètres, commandes/livraisons.
- Formats 1440 px sur ordinateur, 390 px et 320 px sur mobile ; thèmes clair et sombre, y compris un changement de thème via les réglages.
- Douze rubriques des paramètres parcourues sur petit écran.
- Devis fictif : client et titre long, prestation de 2 × 125.50 CHF, TVA 8.1 %, total net 251.00 CHF, TVA 20.33 CHF, total 271.33 CHF. Enregistrement et réouverture de l’aperçu réussis ; parcours rejoué en allemand avec les mêmes montants.
- Lecture du devis adaptée au mobile, mode mise en page, zoom disponible et retour à la liste.
- Formulaire de collaborateur : trois étapes parcourues avec nom et fonction longs, sans enregistrer de collaborateur réel.
- Formulaire de document contrôlé en français, allemand, italien et anglais. Une quantité nulle en anglais produit le message correspondant et place le focus sur la quantité.
- Automation : journal, filtre Factures, recherche avec/sans résultat, À suivre et Réglages.

Aucun débordement horizontal visible de page n’a été constaté lors de la confirmation. Les en-têtes de tableaux conservés pour les lecteurs d’écran et les onglets volontairement défilants ont été distingués des vrais débordements. Les mesures de contraste sont un contrôle ciblé du texte rendu, pas une certification WCAG exhaustive.

Des erreurs React sont apparues uniquement pendant le rechargement à chaud du harnais de test après modification de ses imports. Elles ne sont pas assimilées à un défaut reproduit dans l’application de production. Après rechargement et stabilisation des sources, aucune nouvelle erreur de console n’a été relevée dans le contrôle final.

## Fluidité et limites

Le contrôle du graphe de production vérifie 141 ressources locales et le chargement différé des écrans de paie, éditeur de documents, achats, catalogue, personnalisation, planification et certificats. Le graphe initial mesuré représente 2 046 490 octets de JavaScript, soit 614 721 octets compressés. Par rapport à la première construction de cet audit, la correction des langues ajoute environ 25 Ko de JavaScript (8 Ko compressés), sans nouvelle dépendance. Ces mesures ne représentent pas un temps de démarrage sur appareil. Les avertissements existants sur certains gros modules restent visibles dans le journal de construction.

Le détecteur de style a aussi signalé des valeurs historiques dans les grandes feuilles CSS, notamment des couleurs, tailles, rayons et polices d’impression. Elles ont été examinées comme des indices, sans appliquer de remplacement global susceptible de casser les documents imprimés. Le document de design et son index généré sont désynchronisés ; leur remise en cohérence documentaire reste séparée de cet audit.

Les formats mobiles sont testés dans un navigateur. Pas de nouvelle installation sur un iPhone, un Android ou un Mac physique pendant cet audit. Pas de nouveau test de charge en production, de campagne d’e-mails, de paiement réel ou de test de bout en bout entre deux comptes clients réels. Aucun résultat ici ne permet d’affirmer l’absence absolue de bugs.

## Livraison

Corrections dans le code natif partagé. Les canaux de mise à jour et les téléchargements publics restent inchangés pendant cet audit. Les logs et rapports détaillés sont conservés localement dans `outputs/audit185/`.

La construction Windows finale a réussi. L’exécutable a été lancé deux fois avec un dossier de données de test distinct ; la base est au schéma 60, son intégrité est correcte et les deux processus sont restés actifs pendant l’observation. Ce contrôle ne mesure pas le temps jusqu’au premier affichage. Empreinte SHA-256 du binaire testé : `80951cff5115651ccb9b61465ca52542747dc4e65624e099fe0d2188f9b49b51`. Preuve : `outputs/audit185/windows-smoke.json`. L’application installée chez l’utilisateur et les versions distribuées ne sont pas remplacées.
