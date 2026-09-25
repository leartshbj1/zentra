# Personnalisation et confiance quotidienne — relevé de design

Date du relevé : 25 septembre 2026. Périmètre : interface partagée, personnalisation des raccourcis et actions d’accueil, présentation de la synchronisation et liens du bilan Automation. Cette note documente le code et les preuves disponibles ; elle ne vaut ni publication, ni installation native, ni validation des six priorités produit dans leur ensemble.

## Continuité du système existant

Ce travail prolonge la direction **« Précision calme »**, candidate 3, seed `56c39c55`, du [contrat workspace](../desktop/.impeccable/surfaces/workspace.md). Il s’agit d’une extension ordinaire de l’application Apple-like retenue, sans nouvelle direction visuelle. Les contraintes restent celles de [PRODUCT.md](../desktop/PRODUCT.md) et de [DESIGN.md](../desktop/DESIGN.md) : typographie système, accent Zentra, papier opaque / niveaux de graphite, séparateurs fins, données réelles, terminologie « Projet » et droits de l’entreprise sélectionnée.

`desktop/DESIGN.md` et son [sidecar](../desktop/.impeccable/design.json) sont conservés. Les décisions propres à cette surface sont consignées ici, sans élargir les tokens normatifs pour absorber chaque valeur locale. Le [contrat de personnalisation](../desktop/.impeccable/surfaces/desktop-src-workspacepersonalization-tsx.md) garde ses conditions de livraison ; cette note n’en coche aucune.

Les captures montrent une feuille de réglages opaque, deux segments, un aperçu, quatre lignes séparées et des actions de pied. Les sélections emploient `work-selection`, les actions `work-accent`, les textes `work-ink` / `work-muted`. Le bureau conserve son index ; le téléphone empile les contrôles. Les quatre actions d’accueil forment des lignes sur bureau et une grille de deux colonnes sur téléphone. Aucun nouveau raster de produit n’a été ajouté : les PNG du lot sont des preuves de test, pas des médias à livrer.

## Comportement documenté

| Élément | Contrat observé dans le code |
| --- | --- |
| Barre mobile | Quatre destinations choisies, suivies d’un **Menu** fixe. Les doublons sont évités en échangeant les positions. Une destination absente de la barre sélectionne Menu ; une facture privilégie son raccourci explicite avant le groupe Ventes. |
| Actions de l’accueil | Quatre choix distincts parmi huit actions. Les parcours existants de création ou de navigation restent utilisés ; les actions modifiant les données sont désactivées en lecture seule et les limites métier sont conservées. |
| Brouillon | Changer une liste ou déplacer une ligne actualise l’aperçu. **Enregistrer** applique les deux groupes ; **Annuler** reprend les choix enregistrés. **Réglages par défaut** prépare un brouillon, qui doit lui aussi être enregistré. |
| Persistance | Préférences versionnées dans le stockage local du profil navigateur/WebView, clé `zentra.workspace.preferences.v1`. Elles ne sont pas des préférences synchronisées d’entreprise. Un stockage indisponible conserve la session et affiche cette limite. Le parseur répare les valeurs invalides et les listes incomplètes. |
| Accès Automation | L’accès de l’entreprise détermine l’affichage. Un choix Automation enregistré est conservé lorsque le produit est inactif ; un raccourci de remplacement maintient quatre destinations affichées. |
| Interaction | Sélecteurs natifs, boutons Monter/Descendre de 44 × 44 px, libellés accessibles traduits, focus d’accent visible et message d’enregistrement avec `role="status"`. Le déplacement ne dépend pas d’un geste de glisser-déposer. |

Sources : [WorkspacePersonalization.tsx](../desktop/src/WorkspacePersonalization.tsx), [workspacePreferences.ts](../desktop/src/workspacePreferences.ts), [WorkspaceApp.tsx](../desktop/src/WorkspaceApp.tsx), [MobileDashboard.tsx](../desktop/src/MobileDashboard.tsx) et [styles de personnalisation](../desktop/src/workspace-personalization.css).

L’aperçu anime uniquement le déplacement des éléments déjà présents, pendant **200 ms**, avec `cubic-bezier(.2,.7,.2,1)`. La préférence de mouvement réduit empêche cette animation ; elle supprime aussi la transition des segments. Il ne s’agit pas d’une nouvelle animation d’arrivée du workspace. Les parcours automatisés décrits ci-dessous utilisent le mouvement réduit ; une capture fixe ne prouve pas la qualité temporelle du mouvement normal.

## Statut et résultats factuels

L’indicateur de [synchronisation](../desktop/src/companySync.tsx) ouvre Compte et accès. Son [modèle de présentation](../desktop/src/companySyncPresentation.ts) tient compte de la connexion, de l’identité de l’entreprise, des conflits, erreurs, envois et réceptions. « À jour » exige une vérification récente ou une date de synchronisation admissible : un statut d’une autre entreprise, une date absente, trop ancienne ou anormalement future ne suffit pas. Les états incertains affichent Connexion / Vérification. Le contrôle conserve un intitulé accessible et un détail même lorsque son texte visuel est masqué en format compact.

Le [bilan Automation](../desktop/src/AutomationBrief.tsx) compte les résultats fournis, distingue ce qui reste à valider et ne calcule aucune économie fictive. Ses lignes quotidiennes deviennent des boutons vers la **catégorie correspondante** : factures reçues, rendez-vous, travail préparé ou classements. Ce sont des accès aux résultats concernés, pas des liens directs garantis vers chaque document individuel. L’essai navigateur vérifie l’ouverture d’Automation depuis une ligne du bilan ; il ne prouve pas chaque résultat d’une entreprise réelle.

## Navigation iOS : conservation et limite de preuve

La [session de navigation](../desktop/src/nativeNavigationSession.ts) transmet les identifiants et les libellés traduits des quatre destinations et de Menu. Elle conserve une seule souscription au canal natif, filtre les destinations reçues et rétablit la navigation HTML en cas d’indisponibilité. Le parcours macOS conserve sa configuration existante.

[GlassNavigation.swift](../desktop/plugins/zentra-mobile/ios/Sources/GlassNavigation.swift) continue d’utiliser les configurations UIKit `.glass()` / `.prominentGlass()`, les symboles système et les safe areas. Les changements d’items reconstruisent les contrôles ; UIKit garde le matériau et les états de pression. Le masquage avec clavier et le respect de Reduce Motion restent dans le code. La surface de contenu web reste opaque : le traitement natif ne redéfinit pas les feuilles de travail.

**La compilation UIKit et l’essai du nouveau binaire sur appareil sont en attente.** Les tests du canal JavaScript et les captures WebKit ne prouvent ni le rendu Liquid Glass, ni VoiceOver / Dynamic Type, ni le clavier et les safe areas sur iPhone installé. Aucun résultat d’un ancien binaire n’est utilisé comme preuve de ce changement.

## Relecture et correction de finition

Les premières captures [320 px](../outputs/daily-confidence/review-320.png), [390 px](../outputs/daily-confidence/review-390.png) et [1440 px](../outputs/daily-confidence/review-1440.png), avec les vues de panneau [320](../outputs/daily-confidence/panel-320.png), [390](../outputs/daily-confidence/panel-390.png) et [1440](../outputs/daily-confidence/panel-1440.png), situent la surface dans l’application existante. Le défaut matériel remonté concernait les actions de pied sur téléphone, gênées par la navigation fixe et le bouton assistant.

La correction réserve une zone basse de défilement et un espace final de `164px + var(--safe-bottom, env(safe-area-inset-bottom))`, avec marges de défilement pour le pied et ses boutons. Les captures corrigées [320 px sombre](../outputs/daily-confidence/footer-fixed-320.png) et [390 px clair](../outputs/daily-confidence/footer-fixed-390.png) montrent Réglages par défaut, Annuler et Enregistrer entièrement accessibles au-dessus des deux contrôles fixes, avec une modification non enregistrée.

Le [verdict de finition](../outputs/daily-confidence/finish-review.md) conclut **`disposition: ship` pour cette correction du pied de page** et ne relève plus de défaut restant dans ce périmètre. Ce verdict ne certifie pas toute la surface ni l’exécution UIKit. La présente note conserve cette portée précise.

## Preuves de vérification disponibles

Les [résultats de parcours](../desktop/.qa/personalization/results.json) et le [scénario exécuté](../desktop/tests/personalization-journey.mjs) recensent huit passages réussis :

| Navigateur | Largeur | Langue | Thème |
| --- | ---: | --- | --- |
| Edge et WebKit | 390 px | Français | Clair |
| Edge et WebKit | 320 px | Allemand | Sombre |
| Edge et WebKit | 1440 px | Anglais | Clair |
| Edge et WebKit | 390 px | Italien | Sombre |

Ces passages contrôlent le brouillon sans écriture, Annuler, l’échange d’un choix déjà occupé, Enregistrer, la persistance après rechargement, les valeurs par défaut, cinq boutons de navigation, quatre actions d’accueil, une navigation depuis ces actions, l’absence de débordement horizontal et d’erreur JavaScript. Sur téléphone, le scénario vérifie des cibles de navigation d’au moins 44 px et que les boutons Annuler/Enregistrer sont visibles et atteignables au premier plan après défilement. Le parcours français couvre aussi les états de synchronisation simulés et un lien du bilan quotidien.

Les captures d’accueil [allemand 320 sombre](../desktop/.qa/personalization/edge-320-de-dark-home.png), [italien 390 sombre](../desktop/.qa/personalization/webkit-390-it-dark-home.png) et [anglais 1440 clair](../desktop/.qa/personalization/edge-1440-en-light-home.png) corroborent les compositions et les choix enregistrés. Le [journal de tests](../desktop/.qa/personalization/unit-tests.log) rapporte 1 665 tests réussis dans 207 fichiers ; les tests ciblés de préférences, statut et canal natif existent dans le même lot. Le [build web](../desktop/.qa/personalization/build.log) réussit avec un avertissement de taille de chunks. Le [journal de synchronisation](../desktop/.qa/personalization/sync.log) décrit quatre parcours simulés préservant les éditeurs et le focus, sans voile de chargement.

Ce sont des preuves de harnais navigateur et de tests logiciels, avec données synthétiques. Les quatre langues et les deux thèmes apparaissent dans l’échantillon, mais **pas toutes leurs combinaisons**. Le scénario ne remplace pas un parcours intégral au clavier, une revue avec lecteur d’écran, un essai de synchronisation entre appareils réellement connectés ou une validation des autorisations côté serveur.

## Écarts consignés sans réécriture du système

Le [détecteur exécuté une fois](../outputs/daily-confidence/design-detector.json) produit sept avis, tous de niveau **advisory**. Il n’a pas été relancé pour faire disparaître les signalements.

| Avis | Origine et disposition documentaire |
| --- | --- |
| Titre de personnalisation `24px` ; rayons `9px` et `18px` | Valeurs locales du nouveau composant absentes de l’échelle normative de DESIGN.md. Les occurrences signalées sont consignées ; aucun nouveau token global n’est déduit de leur présence. |
| Panneau de synchronisation : repli `#d6dce5`, rayon `18px` | Préexistants dans `companySync.css` à `HEAD`, confirmés par le diff. Ce lot ne les introduit pas et ne les transforme pas en règles de marque. |
| Indicateur de synchronisation : rayon `9px` | Valeur locale ajoutée, hors échelle documentaire actuelle ; même traitement advisory, sans promotion au système partagé. |

Deux divergences documentaires préexistantes restent visibles : le contrat workspace cite une barre de 72 px et une arrivée de 8 px, tandis que DESIGN.md / son sidecar documentent la couche actuelle à 64 px minimum et 4 px / 220 ms. La personnalisation ne réécrit pas cet historique et ne fait pas de ces anciennes valeurs des alternatives à employer.

La [table de traduction ajoutée](../desktop/src/translationsPersonalization.ts) couvre les nouveaux textes. Cela ne rend pas toute l’application traduite : l’accueil anglais capturé conserve notamment « Projets actifs », « Aucun projet actif » et « Échéances ». La capture allemande étroite montre des ellipses de dock et un retour à la ligne dans un long libellé d’action ; les noms accessibles complets restent fournis par les contrôles. Ces limites sont visibles et ne sont pas effacées du compte rendu. Elles ne sont pas transformées ici en validation linguistique ou d’accessibilité exhaustive.

La documentation de ce lot se limite à ce fichier. Aucun changement d’implémentation, de DESIGN.md, de sidecar ni de case de livraison n’est effectué par ce relevé.

Complément de validation du propriétaire du lot : après ce relevé, un essai de mouvement normal a trouvé une mesure prise avant l’ouverture et le défilement de l’accordéon. La mesure a été corrigée au moment du déplacement, relativement au conteneur. Le [parcours clavier et mouvement](../desktop/tests/personalization-keyboard-motion-journey.mjs) vérifie maintenant Edge/WebKit avec et sans mouvement réduit : deux éléments échangés s’animent, aucun en mouvement réduit. L’activation clavier et la sauvegarde passent ; la tabulation séquentielle n’a été validée que sur Edge. Ce complément ne modifie pas la portée du verdict visuel indépendant ni les limites de validation native.
