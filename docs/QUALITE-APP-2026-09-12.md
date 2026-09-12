# Amélioration continue de Zentra — 12 septembre 2026

Objectif en cours : rendre chaque catégorie compréhensible et vérifier les parcours complets, les données persistées et le comportement mobile. Ce suivi ne signifie pas que l'application est entièrement validée pour tous les usages clients.

## Lot : retrouver les fichiers d’un projet pendant la navigation

Les sélections de fichiers et les opérations d’ajout appartiennent maintenant à l’espace de travail ouvert. Elles restent associées à leur projet lorsque l’utilisateur change de rubrique. Un bandeau permet de retrouver les fichiers à enregistrer ou à reprendre. Les ajouts peuvent continuer en arrière-plan ; seuls les fichiers refusés restent sélectionnés. Une relecture refusée possède une action dédiée, sans répéter l’ajout ou la suppression.

Les fichiers sélectionnés restent en mémoire pendant la session : ils doivent être enregistrés avant de fermer l’application. Les fichiers déjà enregistrés utilisent toujours le cache local durable et la file de synchronisation existants. Un passage en lecture seule interrompt la lecture des fichiers qui n’ont pas encore atteint la commande native et conserve la sélection. Une commande déjà acceptée peut terminer ; les suivantes sont arrêtées. Un changement d’entreprise ferme la session, annule les lectures et ignore les réponses tardives dans l’interface.

Une suppression terminée après la relecture d’un autre projet demande une nouvelle lecture cohérente : elle ne laisse plus le document supprimé affiché comme disponible. La suppression d’un projet avec une sélection ou une opération en cours est bloquée avec un raccourci vers son dossier. Si un projet disparaît de l’espace, les sélections non enregistrées restent visibles et l’utilisateur peut les déplacer explicitement vers un autre projet ; cette action ne transmet aucun fichier et conserve les homonymes.

Validation source : TypeScript, Vite et 39 tests ciblés réussis. Les huit parcours de navigation Edge/WebKit à 320×568, 390×844, 844×390 et 1440×900 couvrent trois projets, navigation pendant un ajout, échec partiel, relecture, lecture seule, suppression concurrente, projet disparu, déplacement explicite et changement d’entreprise. Les six parcours de récupération et les huit parcours de lecture/aperçu précédents passent aussi, soit 22 parcours navigateur. Les captures mobiles ont été inspectées. Les neuf tests natifs de stockage/synchronisation passent : octets exacts, formats, dédoublonnage, sauvegarde/restauration, redémarrage hors réseau, isolation d’entreprise, téléchargement corrompu et priorité aux suppressions.

L’intégration au dossier principal conserve ses commandes et contrôles de partage métier. L’installation d’un état distant attend également les sélections et opérations présentes dans la banque de sessions, même après navigation. TypeScript, Vite, les 39 tests ciblés, 19 tests du cycle métier, les huit nouveaux parcours, un parcours de récupération et trois parcours d’installation distante passent. Ces derniers vérifient explicitement le refus d’installation après avoir quitté un projet avec un fichier sélectionné, puis la reprise après retrait de la sélection. Sauvegarde préalable dans `.qa/project-navigation-20260912-before/`.

Les essais utilisent des profils et fichiers de recette. Ils ne prouvent pas encore une synchronisation réelle entre deux appareils clients. Aucun installateur ni IPA publié par ce lot.

## Lot : couleur et surlignage dans l’atelier de documents

Dans Paramètres → Présentation des documents, les zones d’introduction, de conditions/commentaires et de pied de page proposent maintenant une couleur de texte et un surlignage, avec palettes et couleur personnalisée. Les outils agissent sur les mots sélectionnés ou sur la prochaine saisie. « Effacer la mise en forme » retire les styles des mots sélectionnés ; l’annulation les restitue. Ces outils complètent les polices, tailles, marges, interlignes, positions du logo, tableaux et modèles déjà disponibles pour devis, factures, bilans et fiches de salaire.

Les couleurs sont des valeurs structurées validées, conservées à l’enregistrement et dans les instantanés des documents émis. Le moteur PDF imprime le fond de surlignage avant les caractères, puis rétablit la couleur pour le texte suivant. Le contenu et les valeurs comptables restent issus du moteur existant. Aucun nouveau module externe n’est ajouté.

Validation source : TypeScript, compilation Vite, 12 tests ciblés et 9 contrôles natifs réussis. Les exemples natifs couvrent les quatre familles de documents et les trois polices ; les PDF émis restent identiques après modification des paramètres, et les opérations du QR suisse sont conservées. 18 parcours Edge/WebKit à 320/390/1440 px couvrent sélection, saisie avec style, suppression des styles, annulation, sauvegarde/rechargement, copie vers le bilan, export, listes et reprises d’erreur. Le PDF de contrôle des couleurs et les captures mobiles/ordinateur ont été inspectés.

L’intégration au dossier principal passe TypeScript, Vite, les 12 tests ciblés, le contrôle Rust et trois parcours Edge supplémentaires. Sauvegarde préalable dans `.qa/document-text-colors-20260912-before/`. Les essais navigateur utilisent un environnement de recette et les PDF natifs de référence. Ce lot ne comprend pas l’import de fichiers Word, de polices externes, ni le déplacement libre des champs comptables. Aucun nouvel installateur ni IPA publié.

## Lot : terminer la facturation depuis le dossier du devis

Le dossier propose l’émission de l’acompte, puis celle du solde, après renseignement de leurs dates. Chaque facture émise montre les paiements reçus, les avoirs appliqués et ce qui reste à recevoir. Le paiement s’ouvre depuis cette facture et revient au dossier après enregistrement ou annulation ; une relecture interrompue reprend au même endroit sans répéter le paiement. Les refus d’émission restent visibles dans le dossier. Pendant une action, les autres actions et la fermeture sont bloquées ; la lecture seule conserve la consultation.

La synthèse distingue le montant du devis, les paiements reçus et le reste dû des seules factures émises. Les brouillons sont annoncés séparément. Les avoirs réellement affectés sont repris depuis les soldes du moteur, y compris ceux provenant d’un autre dossier ; un avoir non affecté n’est pas déduit arbitrairement. Les devises différentes ne sont pas additionnées dans une synthèse commune. La déduction de l’acompte et les règles d’émission/calcul natives restent inchangées.

Validation source : TypeScript, Vite et **183 tests ciblés** réussis. Huit nouveaux parcours Edge/WebKit couvrent 320×568, 390×844, 844×390 et 1440×900 : conversion avec deux factures, préparation, ordre d’émission, paiement partiel, annulation, refus puis reprise, avoir affecté, lecture seule et lecture interrompue après encaissement. Les captures mobiles et ordinateur ont été inspectées. Le contrôle natif `quote_invoice_pair_rounding_payment_pdf_and_backup` réussit sur les huit combinaisons de pourcentage et méthode de décompte déjà présentes : arrondis, déduction, émission, paiements, TVA, PDF et sauvegarde/restauration, dont un acompte de 100 %. Les parcours navigateur utilisent des données synthétiques et ne prouvent pas un règlement bancaire réel.

Les huit parcours de paire acompte/solde et les 24 parcours de reprise commerciale précédents passent également, soit 40 parcours navigateur sur la base isolée. L’intégration du dossier principal passe TypeScript, Vite, les 183 tests ciblés et les huit nouveaux parcours Edge/WebKit. Les travaux existants sont conservés ; sauvegarde préalable dans `.qa/quote-folder-20260912-before/`.

Ce lot ne publie aucun nouvel installateur ni IPA ; la version Windows distribuée reste 1.56.0.

## Lot : corrections guidées du collaborateur

Les champs manquants ou mal renseignés reçoivent une explication dans le formulaire, à côté du champ concerné. L’étape nécessaire s’affiche et les rubriques fermées s’ouvrent automatiquement. Les dates d’un contrat déterminé sont contrôlées dès l’étape Travail. Les couples année/montant de pension, chômage et accidents indiquent ce qui manque et le document à consulter ; une valeur inconnue n’est pas remplacée par zéro. Un message bancaire identifié lors de l’enregistrement rejoint l’IBAN. Les autres erreurs de sauvegarde restent affichées avec la saisie conservée. L’assistant reçoit le message de correction courant dans son contexte d’écran.

Le salaire mensuel saisi est conservé lors d’un passage temporaire au paiement horaire. Pendant la sauvegarde, les champs, le retour, la fermeture et les doubles soumissions sont bloqués jusqu’à la réponse. Un refus réactive le formulaire sans effacer les informations. Sur les petites fenêtres, le défilement tient compte du champ et de son explication.

Validation sur la source isolée : TypeScript et Vite réussis ; **103 tests ciblés** et **34 parcours Edge/WebKit** réussis. Les huit nouveaux parcours couvrent 320×568, 390×844, 844×390 et 1440×900, les dates manquantes/inversées, l’e-mail facultatif invalide, les trois montants manquants, le zéro explicite, un refus bancaire, la fermeture pendant une sauvegarde et une seule écriture malgré plusieurs soumissions. Les 26 parcours précédents de création, de choix annuel et de première fiche de salaire passent également. Les captures de correction à 320 px ont été inspectées : le champ et son explication sont visibles. Données synthétiques uniquement ; moteur fiscal et schéma natif inchangés. Rapports dans `desktop/.qa/employee-corrections/` et les dossiers des parcours associés.

Intégration du dossier principal vérifiée : TypeScript, Vite, les 103 tests ciblés et 18 parcours Edge/WebKit réussis (corrections du collaborateur et première fiche de salaire). Les différences propres au dossier principal sont conservées. Sauvegarde préalable : `.qa/employee-corrections-20260912-before/`.

Ce lot est préparé après la publication Windows 1.56.0. Il ne reconstruit ni ne publie d’installateur ou d’IPA.

## Lot : saisie compréhensible des prestations commerciales

Les quantités, prix, remises et pourcentages d’acompte conservent le texte saisi pendant l’édition. La virgule, le point et les séparateurs suisses de milliers sont acceptés ; une précision excessive ou un nombre ambigu est signalé avant l’enregistrement. Un prix vide demande une saisie, tandis qu’un zéro explicite conserve une prestation offerte. Une remise vide vaut zéro. Les unités courantes sont proposées tout en restant libres. Les erreurs indiquent le numéro de ligne et rejoignent le champ concerné ; les anciens taux TVA indisponibles demandent un choix explicite. Le total principal reste « À compléter » tant qu’une saisie numérique est invalide. Pour une prestation d’une journée, la date de fin reprend le début tant qu’elle n’a pas été personnalisée.

Les prix déjà enregistrés, y compris ceux de la base d’un acompte dont les identifiants diffèrent des lignes facturées, sont préremplis. Une ligne invalide supprimée ne bloque pas les suivantes. Les tests couvrent le retour dans les étapes, la réouverture d’un brouillon, le refus d’une sauvegarde et sa reprise avec les mêmes valeurs. Les calculs et règles fiscales natifs ne sont pas modifiés.

Validation source : TypeScript, Vite et **127 fichiers / 1 043 tests d’interface réussis**. Douze parcours de saisie Edge/WebKit à 320/390/1440 px, huit parcours d’assistant sur téléphone, paysage et ordinateur, et 24 parcours de reprise commerciale réussis. Le contrôle natif enregistre puis émet un devis et une facture contenant 2,125 unités à 1 234,56 CHF, une remise de 12,50 %, une TVA de 8,1 % et une prestation offerte ; le total de 2 481,45 CHF et la ligne gratuite se retrouvent dans les PDF finaux. Les captures mobiles de refus ont été inspectées. Ces parcours utilisent des fixtures dédiées et ne remplacent pas une recette sur profil client.

Intégration du dossier principal vérifiée : TypeScript, Vite, 22 tests ciblés, contrôle Rust et six parcours Edge réussis. Une sauvegarde précède les changements dans `.qa/document-number-20260912-before/`. Le positionnement du champ erroné est vérifié après affichage du message pour qu’il reste dans la zone visible, y compris à 320 px. Aucun installateur ni IPA publié dans ce lot.

## Lot : édition de texte et reprise des exports PDF

Le gras, l’italique et le soulignement peuvent être activés avant la saisie ; la barre indique le style actif. La liste à puces bascule uniquement sur les paragraphes sélectionnés. Les retours à la ligne sont conservés lorsque le navigateur remplace un passage mis en forme. Les limites de 60 paragraphes et de 500 changements de style ne coupent plus le contenu : l’éditeur refuse explicitement la modification excessive et garde le texte précédent. Les segments adjacents de même style sont regroupés sans perte.

Les listes exportées conservent le retrait des lignes suivantes et leurs puces en pied de page. Un logo masqué n’est ni chargé ni incorporé au PDF. L’export des devis, factures, bilans, fiches de salaire et exemples conserve le chemin du fichier après un échec du partage mobile. Les contrôles concernés permettent de partager ce fichier à nouveau. Une erreur d’export d’exemple ne bloque plus l’enregistrement du style ni un nouvel essai. Les messages du contrôle PDF commercial ne sont plus tronqués.

Validation source : TypeScript, Vite et 126 fichiers / 1 039 tests réussis ; 19 contrôles natifs liés aux documents, 27 commerciaux, 7 salariaux et 2 comptables réussis (certains filtres se recoupent). Six nouveaux parcours Edge/WebKit à 320/390/1440 px couvrent les styles avant saisie, listes, retour arrière, annulation/rétablissement, lignes vides, conservation après collage excessif, export refusé puis reprise du partage sans seconde génération. Le PDF de contrôle des listes a été rendu et inspecté. Les tests utilisent des fixtures séparées ; ils ne prouvent pas le fonctionnement du dialogue de partage sur un iPhone physique.

Les six parcours de composition précédents passent encore sur Edge/WebKit. Intégration du dossier principal vérifiée : TypeScript, Vite, 18 tests ciblés, contrôle Rust et trois parcours Edge à 320/390/1440 px réussis. Les travaux existants sont conservés ; sauvegarde de cette intégration dans `.qa/document-editor-20260912-before/`. Aucun installateur ni IPA publié dans ce lot.

## Lot : atelier de personnalisation des documents

Les paramètres proposent trois onglets : Style, Mise en page et Textes, pour les devis, factures, bilans et fiches de salaire. Trois points de départ conservent les textes et la couleur. L’utilisateur choisit une famille de police (Helvetica, Times ou Courier), les tailles du corps et du titre, le gras et l’italique du titre, son alignement, les marges et l’interligne. Le logo peut être placé à gauche, au centre, à droite ou masqué ; sa largeur et sa hauteur restent proportionnelles. Le tableau propose un en-tête coloré, des lignes alternées ou des séparateurs, ainsi que quatre densités. Les totaux des documents commerciaux et salariaux peuvent précéder ou suivre les conditions.

L’éditeur de textes conserve des paragraphes et des segments structurés, sans HTML stocké ni exécution du contenu collé. Il propose gras, italique, soulignement, alignement, listes, retours à la ligne, annulation et rétablissement sur la sélection. Sur mobile, une zone à la fois est visible : introduction, conditions/commentaire de fin ou pied de page. Copier une présentation vers une autre catégorie et annuler ce remplacement est possible. Le pied de page mis en forme remplace la phrase simple lorsqu’il est rempli. Les remarques propres à chaque document restent présentes.

Les nouveaux réglages sont enregistrés séparément sous `documentComposition`, en conservant les quatre champs historiques de `documentAppearance`. Sans composition, le moteur précédent est utilisé. Les documents personnalisés utilisent un moteur de mise en page avec mesures des polices standard, retours à la ligne et pagination, sur les valeurs validées et les instantanés existants. Les aperçus des devis, factures et fiches personnalisés passent par le même export natif, dans un dossier temporaire nettoyé à la fermeture de la lecture. L’aperçu d’exemple annonce le nombre total de pages et une éventuelle limite d’affichage. Les exemples ne consomment aucun numéro et ne créent aucune écriture métier. Le QR suisse est repris avec ses opérations et polices d’origine, sur une page de paiement distincte.

Validation : TypeScript et compilation Vite ; **124 fichiers / 1 026 tests d’interface réussis**. Six parcours de studio et de lecture sur Edge/WebKit à 320/390/1440 px couvrent mise en forme de mots, nouvelle ligne, annulation, collage de texte, sauvegarde/rechargement, copie, réinitialisation, erreur d’aperçu, zoom, pagination et export des trois types de documents. L’ancien parcours de présentation passe aussi sur Edge. Les tests natifs couvrent les quatre familles de documents et trois polices, les logos, les valeurs conservées, les styles figés, la non-écriture des exemples, le refus de caractères non imprimables, des documents de 10 pages et plus sans perte de lignes ni débordement, et l’identité des opérations/polices QR. Les contrôles des anciens moteurs commerciaux, salariaux et comptables restent réussis. Les PDF réels ont été rendus et inspectés ; le bilan d’exemple en Times et son compte de résultat tiennent ensemble sur deux pages après ajustement de la densité.

Le dossier principal conserve ses travaux métier et fiscaux en cours. L’intégration possède une sauvegarde dans `.qa/document-composition-20260912-before/` ; TypeScript, Vite, les tests ciblés et le contrôle Rust du dossier principal passent. Les nouvelles vues sont chargées à leur ouverture : le studio représente environ 24,6 kB de JavaScript minifié (7,8 kB compressés), sans nouvelle dépendance applicative.

Périmètre : ces outils configurent les modèles et leurs zones de texte, pas un import/export de fichiers Word ni un placement libre de chaque donnée comptable. Les polices importées et la mise en forme individuelle des remarques de chaque document ne sont pas incluses. Le certificat annuel officiel garde son formulaire. Aucune nouvelle migration, aucun installateur Windows et aucun IPA ne sont publiés par ce lot ; les artefacts déjà publiés ne sont pas remplacés.

## Lot : documents de projet, enregistrements et reprises compréhensibles

L’ajout de plusieurs documents distingue les fichiers conservés sur l’appareil de ceux à reprendre. Seuls les fichiers refusés restent sélectionnés, avec une explication par fichier. Les noms incompatibles sont signalés avant lecture, et les pièces sont classées de la plus récente à la plus ancienne. Les sélecteurs et les actions sont protégés pendant l’enregistrement.

Une lecture interrompue après ajout ou suppression propose « Actualiser la liste », sans réexécuter les écritures confirmées. Ce panneau reçoit le focus et devient visible au centre de l’écran mobile ; une fois la reprise terminée, le clavier rejoint les fichiers. Une suppression refusée affiche son explication dans sa fenêtre de confirmation. Le formulaire de projet conserve ses valeurs, présente les erreurs sur place et ne réécrit pas le même projet lorsqu’il reste seulement une pièce à ajouter. Il utilise aussi la reprise de lecture après une écriture confirmée.

L’ordonnanceur de synchronisation déjà présent dans les travaux du dossier principal est repris et vérifié dans la branche de livraison. Il conserve une actualisation en attente jusqu’à sa réussite, évite les appels concurrents et ignore les réponses d’un contexte fermé. Une demande explicite et le retour du réseau peuvent reprendre immédiatement ; les réveils automatiques conservent leur délai après erreur. Le titre ne présente plus une synchronisation en échec comme terminée.

Validation : TypeScript, compilation et **123 fichiers / 1 023 tests d’interface réussis**. Les six parcours de récupération sur Edge/WebKit à 320/390/1440 px provoquent un ajout partiel, plusieurs refus de lecture, une suppression refusée puis confirmée, un enregistrement de projet refusé et une reprise des pièces sans second projet. La fixture conserve un stockage séparé des instantanés de l’interface : une lecture refusée ne met pas artificiellement la liste à jour. Les huit parcours de consultation vérifient PDF multipages, zoom, texte, PDF endommagé/protégé, images, conservation des octets exportés, fermeture et contrôles accessibles. Les captures mobiles de reprise et de suppression ont été inspectées.

Les **neuf tests natifs de documents/synchronisation** passent : octets exacts, dédoublonnage, formats, altération détectée, sauvegarde/restauration, queue hors réseau après redémarrage, isolation de l’entreprise, fichiers distants corrompus et priorité aux suppressions face à une arrivée tardive. Après fusion dans le dossier principal, TypeScript, compilation, 172 tests ciblés et les six parcours de récupération passent. Les contrôles de partage d’entreprise et leurs verrous sont conservés ; sauvegarde préalable : `.qa/project-recovery-20260912-before/`.

Logs et captures : `desktop/.qa/project-recovery*` et `desktop/.qa/project-files-*`. Aucun code natif, schéma, taux ou version distribuée n’est modifié dans ce lot. Les tests navigateur sont synthétiques et les tests natifs locaux : la synchronisation entre deux appareils réels reste à vérifier. Ces changements ne sont **pas encore dans un nouvel installateur ou IPA**.

## Lot : ouverture plus légère et retour précis aux réglages de paie

Les éditeurs de salaire, devis, factures, achats, catalogue, commandes, dossiers projet et autres écrans secondaires se chargent lors de leur utilisation. La navigation des ventes reste disponible immédiatement. Les panneaux détaillés de paie attendent la première ouverture de leur rubrique ; les champs des formulaires restent présents pour conserver les brouillons et les liens de correction.

La fenêtre d’attente reste refermable, partage un même chargement entre plusieurs ouvertures et ignore une réponse tardive après fermeture. Un refus affiche une explication dans la fenêtre et une action de reprise. Le focus reste dans cette fenêtre lorsque le bouton de reprise disparaît : Échap continue donc de fonctionner. Si le chargement reste impossible, le message invite à revenir au formulaire et à enregistrer le travail avant de relancer Zentra. Aucun rechargement forcé n’efface la saisie.

Les cotisations détaillées et les références réglementaires arrivent après les réglages usuels de paie. Leur chargement ne repousse plus le champ visé depuis la fiche. Le lien « Ouvrir les paramètres de paie » centre la case de contrôle et son explication dans l’écran, conserve le focus et respecte la préférence de réduction des animations. La validation professionnelle reste une confirmation explicite de l’utilisateur. La recette de navigation attend les neuf rubriques réellement présentes, dont l’état de configuration ajouté précédemment.

Mesure sur les deux compilations de production comparables, avec manifestes et source maps : le JavaScript du premier écran passe de **1 396 666 à 948 984 octets**, soit **32,05 % de moins**. Le total gzip des modules passe de 378 319 à 264 095 octets ; le module WorkspaceApp passe d’environ 769 à 302 ko. Le premier écran utilise 34 fichiers JavaScript au lieu de 18. Il s’agit de volumes de code, pas d’une mesure du temps de démarrage sur un appareil. Le contrôle du manifeste vérifie les 97 ressources locales et la configuration Tauri qui embarque tout le dossier `dist`. Le bloc initial index reste au-dessus de 500 ko ; l’avertissement de Vite n’est pas masqué.

Validation : TypeScript, compilation de production, **121 fichiers / 1 008 tests d’interface réussis**. Les 45 scénarios navigateur couvrent l’ouverture différée (8), la première fiche (10), la correction jusqu’au PDF (6), les neuf rubriques de paramètres (5), l’assistant de devis (4), les achats (6) et le catalogue/les coordonnées (6). Edge et WebKit sont utilisés, avec des fenêtres de 320 à 1440 px. Le contrôle d’ouverture parcourt 16 destinations, retarde le module de salaire, ferme et rouvre sa fenêtre, enregistre un brouillon, vérifie une seule demande du module et refuse toute ressource externe dans la fixture. Une fixture React StrictMode provoque un refus synthétique, puis vérifie la reprise, la conservation du formulaire parent, une résolution après fermeture et la conservation de la saisie après changement de propriétés. Les captures mobiles de chargement et de réglage, ainsi que l’arrivée au champ dans WebKit sur ordinateur, sont inspectées.

Après fusion dans le dossier principal : TypeScript et compilation réussis, 14 tests ciblés et 14 scénarios navigateur de paie/ouverture réussis. Les travaux de synchronisation d’entreprise et de paie propres au dossier principal sont conservés. Sauvegarde : `.qa/opening-20260912-before/`. Rapports et logs : `desktop/.qa/opening-*` et rapports des recettes concernées. Le script reproductible de mesure est `desktop/scripts/audit-opening-bundle.mjs`.

Ce lot reste **postérieur à Windows 1.55.0 et non publié**. Aucun nouvel installateur ou IPA n’est généré ; aucun taux, calcul natif ni schéma de base n’est modifié. Les recettes utilisent des données synthétiques et un serveur local : elles ne prouvent pas une installation mobile ni le fonctionnement hors réseau d’une installation physique. La reprise testée d’un refus synthétique ne garantit pas qu’un cache de WebView retentera toute erreur réseau réelle.

## Lot : terminer une fiche de salaire sans refaire les réglages

Les corrections de contrat, de caisse et de cotisation reprennent maintenant les nouvelles cotisations applicables dans la fiche en cours après un enregistrement confirmé et une relecture réussie. Les cotisations déjà proposées puis écartées, les bases manuelles, les cumuls et les zéros explicitement saisis ne sont pas remplacés. Le contexte collaborateur/mois/date est vérifié avant la reprise. Les choix intermédiaires restent masqués pendant cette actualisation. Sur le scénario complet de première fiche, les trois actions répétées « Utiliser ces cotisations » ont disparu : quatre ouvertures de réglages restent après la saisie du contrat, au lieu de sept actions de préparation.

Le contrat de pension indique le champ exact à compléter : caisse, numéro, référence, début, fin ou confirmation de la part entreprise. Les dates incohérentes et les périodes qui ne couvrent pas la date utilisée par la fiche sont signalées avant toute écriture. La vérification de période porte sur une correction de pension ou un plan modifié ; changer une autre assurance ne crée pas cette obligation sur un plan inchangé. Le guide explique où retrouver l’information et conserve les valeurs refusées. Les erreurs apparaissent aussi sous le champ concerné, sont lisibles sur 320 px et disparaissent lors de sa correction. Le nom des caisses et les champs contrôlés par React conservent correctement le texte saisi.

Les champs de début d’année expliquent maintenant à quoi servent la date et le nom du document. La liste propose « Contrôler la fiche » et « Voir le PDF ». Le message de configuration non contrôlée ouvre directement la confirmation de contrôle dans les paramètres de paie ; ce champ est visible dans la fenêtre après le défilement. Aucun contrôle par une fiduciaire n’est confirmé automatiquement. Après contrôle explicite dans la recette, la même fiche est reprise, validée et exportée sans doublon.

Références officielles relues pour les explications : [financement de la prévoyance professionnelle — OFAS](https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle), [aperçu des cotisations — OFAS](https://www.bsv.admin.ch/fr/cotisations-apercu), [mémo AVS/AI 2.04 sur les petits salaires](https://www.ahv-iv.ch/p/2.04.f). Les taux, décisions natives et règles de comptabilisation ne changent pas dans ce lot.

Validation : **120 fichiers / 1 005 tests d’interface réussis**, TypeScript et compilation Vite réussis. Les 42 scénarios navigateur réussissent : première fiche (10), correction jusqu’au PDF (6), chemin clair et récupération (6), salaire horaire et compléments (12), aide à l’ajout d’un collaborateur (8). Edge et WebKit sont couverts, avec formats de 320 à 1440 px. Le scénario de PDF conserve une base manuelle, refuse trois erreurs de contrat avant écriture, interrompt la relecture après les deux montants de pension, puis reprend le même identifiant de fiche. Il vérifie que le contrôle professionnel reste faux tant que la recette ne le confirme pas explicitement. Les captures d’erreur, de liste et de navigation vers les réglages ont été inspectées.

Après fusion dans le dossier principal : TypeScript, 126 tests ciblés et 24 scénarios navigateur de première fiche/correction/ajout réussissent. Le test de focus attend son arrivée effective après le rendu, au lieu d’exiger un effet synchrone. Les autres travaux du dossier principal sont conservés ; sauvegarde préalable : `.qa/payroll-finish-20260912-before/`. Logs et rapports : `desktop/.qa/payroll-finish*`, `payroll-first-payslip*`, `payroll-clear-path*`, `payroll-salary-entry*` et `employee-annual-help*`.

Ce lot est **postérieur à Windows 1.55.0 et n’est pas encore publié**. Les exports navigateur utilisent exclusivement des données et réponses synthétiques ; ils ne prouvent pas une installation ni un export natif sur iPhone. Aucun nouvel installateur ou IPA n’est généré. Le schéma natif de livraison reste 59. Le module WorkspaceApp atteint environ 769 ko minifiés ; son découpage reste à améliorer.

## Lot : importer le catalogue et reprendre les coordonnées

L'import montre toutes les lignes par pages et propose un filtre sur les points à corriger. Une erreur après la ligne 100 n'est plus invisible. Chaque ligne peut être corrigée dans l'application : référence, désignation, prix, unité, type et TVA. La correction conserve le numéro de ligne d'origine et relance le contrôle des doublons. Le fichier fourni n'est pas modifié. Sur mobile, les lignes sont présentées en fiches lisibles, avec les montants et leur contrôle ; les textes et boutons de pagination ont été ajustés après inspection des captures.

Les prix d'achat texte illisibles ne deviennent plus des zéros importables. Les caractères inconnus ou devises étrangères présentes dans un prix texte sont refusés, et les montants hors de la plage native sont signalés. Un pourcentage explicite comme « 0,5 % » conserve son sens ; les fractions numériques Excel restent prises en charge. La correction d'une ligne conserve les autres erreurs du fichier. Les longueurs et caractères de contrôle sont vérifiés avant l'envoi au moteur natif.

Le choix « Conserver les fiches actuelles » affiche le bon résultat dans l'aperçu. La transformation d'un produit suivi en stock en service est signalée avant l'import en mode mise à jour. Un enregistrement confirmé suivi d'une lecture interrompue attend uniquement une relecture : le fichier n'est pas réimporté. Fichier, choix et corrections restent disponibles après un refus. Les formulaires client et fournisseur affichent leur erreur sur place et protègent la saisie pendant l'enregistrement. La recherche d'écran retrouve désormais le catalogue avec le mot « catalogue ».

Validation : **118 fichiers / 994 tests d'interface réussis**, TypeScript et compilation Vite réussis. Les 6 parcours Edge/WebKit à 320/390/1440 px importent un CSV de 105 références, corrigent la ligne 103, vérifient le mode de conservation, les prix, le stock et l'état archivé, puis provoquent un refus et plusieurs échecs de lecture sans deuxième import. Ils couvrent également le refus de création client/fournisseur, la conservation des coordonnées et l'archivage/réactivation du client. Les captures mobiles ont été inspectées après ajustement de la lisibilité.

Les deux tests natifs d'import catalogue (atomicité, références, stock et charges invalides) et le test natif d'archivage du client passent. Le moteur natif n'est pas modifié dans ce lot. Après intégration au dossier principal, TypeScript, 188 tests ciblés et les 6 parcours navigateur passent également. Sauvegarde : `.qa/directory-20260912-before/`. Les données navigateur sont synthétiques et ne remplacent pas une recette sur un profil client installé.

Ces corrections, comme le lot achats précédent, ne sont **pas encore publiées**. La version Windows distribuée reste 1.55.0. Le module `WorkspaceApp` atteint environ 763 ko minifiés ; son découpage reste nécessaire pour améliorer le premier chargement.
## Lot : achats, justificatifs et paiements compréhensibles

Les achats utilisent les catégories de départ déjà proposées par leur éditeur : l'absence de catégories personnalisées ne bloque plus la première facture. Le formulaire situe les étapes « Recopier », « Joindre l’original » et « Valider ». Après enregistrement, le justificatif devient visible et une seule action « Terminer » clôt la saisie. Les modifications ultérieures, y compris l'ajout ou le retrait de lignes, demandent à nouveau un enregistrement.

Les erreurs du brouillon, du justificatif, de la dépense et du paiement sont affichées dans le formulaire concerné. La saisie reste disponible après refus ; fermeture et champs sont protégés pendant l'opération. Le paiement accepte la virgule, explique les montants dépassant le solde et consulte le solde actualisé. Si une réponse est perdue mais que le paiement portant la même requête est retrouvé, son montant et sa date sont montrés sans proposer un second enregistrement.

Le traitement TVA choisi pour toutes les lignes et le brouillon sont désormais enregistrés dans la même transaction native. Le refus d'un classement annule aussi les autres classements, les lignes et leur audit. Le classement existant reste conservé quand aucun nouveau traitement n'est demandé. Les commandes de brouillon, import e-mail, justificatif, suppression et règlement distinguent une écriture confirmée d'une lecture interrompue ; leur reprise ne réexécute pas la commande. Aucun taux fiscal n'est modifié par ce lot.

Validation : **118 fichiers / 984 tests d'interface réussis**, TypeScript et compilation Vite réussis. Les 6 parcours `purchase-clear-journey` couvrent Edge et WebKit à 320/390/1440 px : absence de catégorie personnalisée, brouillon, erreur, classement demandé, ajout d'un justificatif, validation, paiement partiel puis solde, réponse perdue et plusieurs reprises de lecture. Les captures mobiles ont été inspectées. Les 5 parcours d'achats sans assujettissement réussissent à 320/390/768/1024/1440 px et conservent les montants HT/TVA/TTC du fournisseur.

Le test SQLite `draft_and_all_vat_choices_roll_back_together_and_retry_without_duplicates` provoque un refus du deuxième classement et vérifie l'absence de brouillon, de lignes, de classement partiel et d'audit résiduel. Il vérifie aussi la reprise identique sans doublon, l'annulation d'une modification refusée et la conservation des classements existants. Les trois tests natifs de cycle fournisseur, périodes clôturées et écart de rapprochement réussissent. Après report dans le dossier principal, TypeScript, 191 tests ciblés, les 6 parcours navigateur et le test SQLite atomique passent également. Sauvegarde avant fusion : `.qa/purchase-clear-20260912-before/`.

Ce lot est **postérieur à Windows 1.55.0 et n'est pas encore publié**. Le schéma de la base de livraison reste 59. Les autres travaux du dossier principal sont conservés. Les recettes navigateur utilisent des données synthétiques ; une installation sur un profil client réel reste à vérifier. Le module `WorkspaceApp` représente environ 756 ko minifiés et son découpage reste à améliorer.
## Lot : un chemin plus clair vers le salaire net

Le salaire du mois est séparé des réglages détaillés, rangés sous « Mes cotisations et assurances ». Un résumé annonce la prochaine action réelle : compléter les informations manquantes, confirmer une base ou calculer le net. Le collaborateur et le mois restent visibles. Les corrections ouvertes depuis le salaire utilisent aussi le guide par questions ; une ligne à classer renvoie à ses propres champs.

Le chargement interrompu des cotisations et comptes est affiché en dehors des étapes masquées. La reprise reste accessible depuis la préparation ; tant que les informations sont indisponibles, celle-ci n'annonce pas une préparation terminée et ne laisse pas calculer. Les réponses déjà enregistrées ne sont pas réécrites lors du réessai. Après le dernier réglage, le bouton « Calculer le net » rejoint directement la vérification. La vérification calculée propose une seule sauvegarde de fiche ; le brouillon reste disponible pendant la saisie.

Validation : 117 fichiers / 960 tests d'interface, TypeScript et compilation Vite réussis. Les 6 scénarios `payroll-clear-path`, 10 de première fiche et 12 de salaire horaire/compléments réussissent sur Edge et WebKit. Les erreurs de lecture, refus de sauvegarde et écriture partielle des deux cotisations de pension sont injectés dans la fixture synthétique. Les captures mobiles sont inspectées. Après intégration au dossier principal, TypeScript, 87 tests ciblés et les 16 scénarios de chemin clair/première fiche réussissent. Sauvegarde : `.qa/payroll-clear-20260912-before/`.

Le moteur natif et ses taux ne changent pas. Ces résultats ne constituent pas un essai d'installation sur iPhone. Le module `WorkspaceApp` représente environ 751 ko minifiés. La publication Windows de ce lot est suivie séparément.
## Lot : conserver les devis, corrections et règlements après une interruption

Les commandes de devis/factures, émission, conversion, solde et paiement distinguent une écriture réussie d'une lecture interrompue. Les identifiants de révision et de facture de remplacement sont récupérés avant la relecture : reprendre ouvre le document créé sans relancer la commande. Les erreurs de saisie et les refus natifs restent dans le formulaire.

Le règlement propose le solde restant, la date de réception et un libellé de moyen de paiement ; le montant, la date et les dépassements sont expliqués avant l'envoi. Les dates et notes d'une facture liée sont enregistrées avant de rejoindre son dossier. La consultation en lecture seule reste refermable.

Validation : 117 fichiers / 960 tests d'interface, TypeScript et compilation réussis. 24 parcours de récupération sur Edge/WebKit à 320/390/1440 px, 8 parcours de factures liées et 4 parcours de l'assistant de devis réussis. Les tests natifs de paire acompte/solde avec PDF et sauvegarde, de correction d'une facture payée et d'atomicité paiement/écriture comptable réussissent. L'intégration au dossier principal passe TypeScript, 161 tests ciblés et les 32 parcours de récupération/paire. Sauvegarde préalable : `.qa/sales-20260912-before/`. Les recettes navigateur sont synthétiques ; aucune installation ou publication nouvelle n'est attestée.
## Lot : comprendre les compléments et les salaires horaires

La priorité est revenue à la création de paie à la demande de l'utilisateur. Les changements de ce lot partent de `24d92fb` sur la base de livraison 1.54.0.

- **Montants soumis aux assurances.** Le passage à la vérification ouvre une question à la fois lorsqu'un montant est inconnu. Un exemple distingue le salaire soumis du montant retenu. Les parts AVS/AI/APG et chômage sont regroupées suivant les règles de partage déjà présentes dans l'éditeur. Les contrats distincts gardent leurs propres montants ; aucun montant inconnu n'est remplacé par zéro.
- **Corrections.** Les réponses restent disponibles au retour à la question précédente, y compris une réponse pas encore confirmée. Après modification des éléments du brut, les bases manuelles confirmées demandent une nouvelle vérification. Les champs de salaire sont contrôlés avant les réglages d'assurance, afin d'éviter une erreur de champ caché comme première réponse.
- **Salaire horaire.** Un calcul heures × tarif brut reporte explicitement le montant et son détail sur une seule ligne de salaire. La virgule décimale est acceptée et le résultat est arrondi au centime. Le coût interne de projet n'est jamais utilisé comme tarif salarial. Une modification des heures ou du tarif doit être reportée avant calcul ou sauvegarde ; le message ouvre directement le calcul horaire.
- **Explications adaptées.** L'introduction distingue le salaire mensuel prérempli, le salaire à renseigner et le calcul horaire. L'assistant de l'application reçoit aussi l'étape réelle du guide de montants.

Validation du lot : **116 fichiers / 926 tests d'interface réussis**, TypeScript et compilation Vite réussis. Les 12 scénarios de `payroll-salary-entry-journey.mjs` couvrent Edge et WebKit à 320, 390 et 1440 px : prime, bases partagées, modification du brut, retour en arrière, erreur puis réessai d'enregistrement, salaire horaire, tarif indépendant du coût et remplacement sans doublon. Les 10 scénarios de première fiche/configuration de pension ont également été rejoués. Données exclusivement synthétiques ; les captures mobiles ont été inspectées.

L'intégration au dossier principal conserve sa classification des revenus et les autres travaux existants. TypeScript et 67 tests ciblés y passent. Ses 12 scénarios de saisie passent également : la recette vide explicitement une base pour exercer le guide, car ce dossier sait déjà classer les compléments ordinaires. Le premier salaire horaire peut demander de reprendre les cotisations devenues applicables une fois le montant connu. Sauvegarde des fichiers avant intégration : `.qa/payroll-entry-20260912-before/`.

Les nouveaux composants n'ajoutent aucune dépendance. Le module `WorkspaceApp` compilé atteint environ 744 ko minifiés ; le découpage reste à améliorer. Le moteur natif et les taux ne sont pas modifiés dans ce lot. La validation sur une installation réelle et la construction des nouveaux binaires restent à faire : **aucun nouvel installateur ou IPA n'est publié par ce lot**.

## Lot : reprendre son salaire et retrouver ses enregistrements

Base isolée : `dac39ed`, dernière version Windows livrée 1.54.0. Branche de travail : `codex/app-quality-20260912`. Les modifications sont également reportées par fusion à trois versions dans le dossier principal, en conservant ses travaux sur les revenus de paie et la synchronisation. Le schéma natif de la base de livraison reste 59 ; celui des travaux non publiés du dossier principal reste distinct.

- **Fiches de salaire.** Le bouton de sauvegarde partielle est accessible dès l'étape du salaire, sans devoir provoquer une erreur. Un brouillon peut être rouvert, corrigé et sauvegardé sous le même identifiant avant la fin des réglages. Les informations déjà enregistrées dans les assurances restent disponibles.
- **Protection des calculs.** La sauvegarde sans cotisations ne s'applique pas à une fiche contenant déjà des cotisations persistées, ni à une fiche validée/comptabilisée/payée. Le bouton de fermeture et Échap sont désactivés pendant l'écriture. Une tentative refusée conserve la saisie ; les clics rapprochés partagent la même sauvegarde.
- **Liste de paie.** Le filtre « Brouillons · à compléter » retrouve les fiches à reprendre. Le net reste affiché « À calculer ». La sauvegarde d'un brouillon ne valide pas la paie et ne permet pas son paiement.
- **Clients, catalogue, fournisseurs, collaborateurs, heures et dépenses.** Les créations/modifications/archives distinguent maintenant une commande native réussie d'une lecture interrompue. L'interface relit les données sans recommencer la commande.
- **Planning et chronomètre.** La même protection couvre les tâches, jalons, changements d'état, suppressions et démarrage/arrêt du pointage. Elle ne remplace pas le contrôle transactionnel ou les identifiants de requête propres aux opérations financières.
- **Début d'un parcours.** Lorsqu'une création demande un client, un fournisseur, un collaborateur, un projet actif ou des réglages confirmés, l'explication est visible sous le bouton. L'action voisine ouvre le bon formulaire ou la rubrique précise des paramètres. Le bouton inutilisable dans l'état vide des projets est supprimé. Ces raccourcis respectent la lecture seule.

## Preuves de ce lot

Les recettes navigateur utilisent uniquement des données synthétiques, sans compte ni paie de client.

| Vérification | Résultat |
| --- | --- |
| Base avant modifications | 115 fichiers, 835 tests d'interface réussis |
| Après modifications | 115 fichiers, 910 tests d'interface réussis |
| Compilation TypeScript et Vite | Réussies sur la base isolée |
| `payroll-draft-continuity-journey.mjs` | Edge 320/390/1440 px, WebKit 390 px ; reprise, échec/réessai, double clic, filtre et cotisations historiques préservées |
| `payroll-first-payslip-journey.mjs` | 10 scénarios Edge/WebKit réussis, dont configuration complète et création d'un collaborateur depuis la fiche |
| `entity-recovery-journey.mjs` | 320/390/1440 px ; panne de lecture persistante, un seul client créé, formulaire retrouvé avec les mêmes coordonnées |
| `workflow-help-journey.mjs` | 320/390/1440 px ; client ajouté avant le projet, rubrique de facturation réellement visible dans l'écran, accès fournisseur/projets et lecture seule préservée |
| Navigation et largeur des pages | 16 catégories à 320/390/1440 px, 48 parcours sans débordement horizontal ni erreur JavaScript |
| Persistance SQLite du brouillon | Test natif `incomplete_payroll_draft_can_be_reopened_and_updated_without_duplicates` réussi : même fiche, même date de création, montant et notes corrigés, aucune ligne dupliquée |
| Ensemble des tests natifs sur la base de livraison | 647 réussis, 0 échec, 2 recettes HTTPS explicitement ignorées ; 821,73 secondes |

Les deux recettes natives ignorées concernent une sauvegarde/restauration HTTPS entre deux installations avec autorisation de test, et le rafraîchissement HTTPS public de licence réservé au contrôle de publication. Les protections locales passent ; ces deux parcours externes ne sont pas attestés par cette campagne.

Après fusion dans le dossier principal, TypeScript et les 13 scénarios navigateur de reprise de brouillon, aide aux prérequis et récupération de client passent également. Les 159 tests ciblés de paie/récupération y ont réussi avant le dernier ajout des raccourcis.
Le test natif de reprise du même brouillon passe également dans ce dossier, avec sa classification des revenus non publiée. Ses champs de revenu ordinaires sont explicitement renseignés dans la version du test reportée ; les autres travaux existants sont conservés.

Les logs et images de ces vérifications se trouvent dans `.qa/` du dossier de travail isolé. Les tests de refus de commandes et de lecture interrompue de `workspaceMutation.test.ts` vérifient séparément les appels réels du bridge natif ; la recette navigateur vérifie l'interaction et la récupération affichée.

## Suite de l'audit, par catégorie

| Catégorie | Couverture actuelle de ce lot | Travail restant |
| --- | --- | --- |
| Paie et collaborateurs | Parcours première fiche, correction et reprise du brouillon ; persistance native ciblée | Essais avec une entreprise de recette sur l'application installée ; intégration contrôlée des travaux natifs sur la classification des revenus |
| Clients, catalogue et fournisseurs | Récupération après écriture, création/édition du client, navigation mobile | Vérifier les parcours d'import, d'archivage et les relations commerciales de bout en bout |
| Projets, planning, documents et photos | Commandes de planning protégées ; écrans accessibles | Synchronisation réelle entre deux appareils, pièces jointes hors ligne et conflits ; intégrer les évolutions de synchronisation isolément |
| Devis, factures, acomptes et commandes | Navigation, protections communes des mutations | Nouvelle recette complète devis → acompte → solde, export et règlements sur un profil de recette |
| Achats, stocks, banque et comptabilité | Tests du bridge, campagne native générale et navigation | Vérifier les imports bancaires, justificatifs et clôtures dans l'interface sur un profil de recette |
| TVA et certificat annuel | Moteur non modifié par ce lot | Revalider les exemples métier et les exports contre les règles applicables ; aucun statut de certification Swissdec n'est déduit de tests |
| Paramètres, sauvegardes et assistant | Navigation et compilation | Restauration sur une installation distincte, Qwen en conditions réelles et configuration des e-mails de production |
| Windows, macOS, iOS et Android | Interface partagée testée en navigateur ; compilation web réussie | Construire et vérifier chaque binaire, installation et mise à niveau avant toute annonce de disponibilité sur sa plateforme |

## Distribution

Les lots de paie et de reprise commerciale livrés précédemment sont publiés pour Windows en version 1.55.0, avec signature Tauri vérifiée, canal de mise à jour et page de téléchargement publics. Les lots achats/justificatifs et catalogue/coordonnées ajoutés ensuite ne sont pas encore distribués. L'IPA non signé reste en 1.53.0. Le présent audit n'atteste ni installation client, ni nouvelles versions macOS/Android. Voir RELEASE-WINDOWS-1.55.0.md pour les artefacts et preuves de la version publiée.

Le premier chargement contient encore un module `WorkspaceApp` d'environ 732 ko minifiés. Son découpage et les temps de réponse sur appareil mobile restent à examiner, en maintenant l'accès hors ligne aux fonctionnalités.

## Livraison Windows 1.55.0

Publication vérifiée le 12 septembre 2026 : installateur Windows 1.55.0, signature Tauri et empreinte disponibles sur GitHub et Supabase. Le fichier téléchargé publiquement correspond à l'artefact compilé et sa signature Ed25519 a été vérifiée. Le manifeste public `latest-windows.json` pointe vers cette version ; le canal partagé `latest.json` est inchangé et le manifeste Windows précédent est conservé.

La page de téléchargement publique est publiée via Sites, version 121. Le lien Windows, l'empreinte et le texte de présentation ont été relus dans le HTML public. Source binaire : `a303f0777828cbe698beaa054bbcaafa65dd4706` ; source du site : `4ce11f1d1d0a975631228fd6ccf7156e6301857b`. Détails : [RELEASE-WINDOWS-1.55.0.md](RELEASE-WINDOWS-1.55.0.md).

Cette publication ne constitue pas une validation sur un profil client réel. Authenticode reste indisponible. Aucun nouvel IPA ou paquet macOS/Android n'est inclus.


## Lot : importer et confirmer les paiements sans perdre le contexte

L’import bancaire dispose d’un guide, d’un choix de fichier distinct de l’enregistrement et d’un résultat détaillant les nouveaux mouvements, doublons et paiements reconnus. Les refus conservent le fichier et l’option choisie. Après un import enregistré dont la relecture échoue, le bouton d’actualisation reprend uniquement les lectures.

Les confirmations client, fournisseur et d’association de compte utilisent des fenêtres de l’application. Les paiements affichent la facture, le montant, le reste dû avant et après, la contrepartie et la date. Les erreurs restent dans la fenêtre, prennent le focus et dirigent directement vers Exercices pour une période clôturée ou Plan & liaisons pour la configuration. Le choix d’import automatique reste conservé pendant la session, y compris après une visite de la comptabilité ; le test a révélé et permis de corriger sa réactivation involontaire lors du retour à Banque.

Validation : TypeScript et Vite dans les deux dossiers ; 30 tests bancaires d’interface dans chacun, 46 tests comptabilité/trop-perçus supplémentaires dans le dossier principal, 72 tests natifs bancaires. Les huit parcours guidés Edge/WebKit passent dans chaque dossier (320×568, 390×844, 844×390, 1440×900) et les cinq parcours bancaires existants passent sur la base de livraison. Les captures ont été inspectées. La fusion préserve la gestion des trop-perçus et ses blocages dans le dossier principal ; sauvegardes dans .qa/bank-guided-before, .qa/bank-accounting-navigation-before et .qa/bank-import-choice-before.

Le moteur et le schéma restent inchangés. Données de recette uniquement ; aucune publication d’installateur ou d’IPA dans ce lot. La livraison Windows reste 1.58.0. Guide : [BANQUE-PAIEMENTS.md](BANQUE-PAIEMENTS.md).

## Lot : tâches et étapes avec corrections accessibles

La création et la modification de tâches et d’étapes utilisent un formulaire contrôlé. Un titre et un projet suffisent ; les informations secondaires sont facultatives et les précisions sont regroupées. Les refus conservent la saisie. Les dates incompatibles expliquent le lien avec l’étape ou une tâche et proposent une correction explicite. Le défilement tient compte des actions fixes en bas de la fenêtre mobile : le bouton de correction reste accessible avec l’explication.

Le planning oriente vers les tâches qui empêchent de terminer une étape, vers l’étape à rouvrir ou vers le chronomètre en cours. Les compteurs suivent le filtre d’étape. Après un enregistrement, la recherche et les filtres restrictifs sont retirés pour afficher l’élément enregistré. Les libellés des actions et les textes du planning ont été agrandis.

Intégration dans le dossier principal avec fusion à trois versions. Le seul conflit concernait l’import de la recette de planning à côté d’un import existant de l’assistant ; les deux recettes ont été conservées sans doublon. Sauvegarde du contenu précédent dans `.qa/planning-guided-before`. Les évolutions commerciales et de synchronisation du dossier principal sont conservées ; aucun changement de schéma natif dans ce lot.

Validation : 168 tests d’interface du planning et des mutations dans chaque dossier, 6 tests natifs du planning dans chaque dossier, et 8 parcours Edge/WebKit dans chaque dossier aux quatre formats 320×568, 390×844, 844×390 et 1440×900. Les captures ont été inspectées, dont la visibilité de l’aide à la date au-dessus des actions fixes. Guide : [PLANNING-PROJETS.md](PLANNING-PROJETS.md).

Les ajouts récents de l’atelier de documents ont également été reportés dans la base de livraison avec une fusion à trois versions : collage mis en forme, styles de paragraphe, espace d’écriture et accès aux éléments du document. Leurs 22 tests d’interface et leurs six parcours Edge/WebKit passent après intégration ; cela porte la sélection d’interface de ce lot à 190 tests dans chaque dossier. TypeScript et Vite passent dans les deux dossiers. Voir [PERSONNALISATION-DOCUMENTS.md](PERSONNALISATION-DOCUMENTS.md).

Aucun nouveau binaire Windows, macOS, iOS ou Android n’a été construit ou publié dans ce lot. La synchronisation réelle du planning, les conflits entre appareils et la recette sur application installée restent à vérifier.

## Lot : dates des factures récurrentes et arrêt expliqué

La création d’une planification affiche les prochaines dates de brouillon et de paiement, ainsi que le nombre de dates à rattraper et la limite du premier lot. Le calcul reprend le jour original et le repère de fin de mois.

Les planifications existantes disposent de **Modifier la date de fin**. Le formulaire valide le début et les occurrences existantes, propose la première date compatible et conserve la saisie après refus. Prolonger ou retirer la fin ne réactive pas une planification en pause ; une planification à vérifier reste en pause. Une fin antérieure à la prochaine occurrence est expliquée comme un arrêt définitif avant confirmation. L’arrêt direct utilise désormais une fenêtre de l’application.

L’enregistrement garde un identifiant stable pendant les essais du même choix. Le formulaire est verrouillé pendant l’écriture ; la reprise après un succès suivi d’une erreur de lecture relit les données sans répéter la modification. Les factures existantes restent intactes.

Validation : 36 tests d’interface et 6 tests natifs dans chaque dossier, 8 parcours Edge/WebKit dans chaque dossier aux quatre formats 320×568, 390×844, 844×390 et 1440×900, et 10 parcours existants dans Edge sur la base de livraison. Les essais couvrent notamment l’année bissextile, le rattrapage, le refus d’une date, le double clic, l’erreur de lecture persistante puis sa reprise, la pause, l’arrêt par date et l’historique. Les anciennes recettes ont été adaptées au guide automatique et à l’étape Prestations de l’éditeur actuel. TypeScript et Vite compilent dans les deux dossiers ; les captures ont été inspectées.

Intégration dans le dossier principal par fusion à trois versions sans conflit, avec sauvegarde dans `.qa/recurrence-dates-before`. Le moteur natif et le schéma sont inchangés. Guide : [FACTURES-RECURRENTES.md](FACTURES-RECURRENTES.md). Aucune donnée client modifiée, aucun nouvel installateur ni IPA publié dans ce lot.

## Lot : vérifier une facture et reprendre ses corrections

L’émission d’une facture utilise une fenêtre de l’application avec le total en premier, le client, les dates, la prestation, le hors TVA et la TVA. Le détail des lignes est dépliable. La confirmation indique l’attribution d’un numéro et le verrouillage du document. Annuler ne modifie rien ; l’émission n’envoie aucun e-mail et ne crée pas de paiement.

Les dates manquantes ou incompatibles dirigent directement vers Conditions, ou vers les dates de la facture liée. Un IBAN manquant dirige vers la rubrique de facturation. Les refus liés à une période fermée proposent les exercices et la correction de la date du brouillon ; les comptes manquants dirigent vers Plan & liaisons. Un rappel permet de reprendre la vérification de la même facture après avoir enregistré une correction. Les valeurs courantes sont relues depuis l’espace de travail. Le message natif complet reste accessible.

La conversion du devis conserve maintenant le choix et le pourcentage après refus, montre l’erreur dans sa fenêtre et empêche la modification ou la fermeture pendant l’écriture. La confirmation d’émission empêche les doubles clics, tient compte de la lecture seule et utilise la reprise existante des lectures après une écriture confirmée.

Validation dans les deux dossiers : 45 tests d’interface, 8 parcours de facture simple Edge/WebKit et 8 parcours de dossier avec acompte Edge/WebKit (320×568, 390×844, 844×390, 1440×900). Huit parcours existants dans Edge passent aussi sur la base de livraison, pour les dossiers neufs et les anciens acomptes à compléter. Deux tests natifs dans chaque dossier vérifient plusieurs pourcentages, les arrondis, la déduction, les numéros, les paiements, les PDF, les écritures, les deux formes de comptabilisation de TVA déjà implémentées et la restauration. Il s’agit de données synthétiques et de tests de non-régression ; aucun calcul fiscal ni schéma natif n’a changé.

TypeScript et Vite compilent dans les deux dossiers. Les captures du total et des corrections sur petit écran ont été inspectées. Intégration par fusion à trois versions sans conflit ; sauvegarde du dossier principal dans `.qa/invoice-issue-before`. Les évolutions de synchronisation et de comptabilité du dossier principal sont conservées.

Guide : [DEVIS-FACTURES.md](DEVIS-FACTURES.md). Aucun nouvel installateur ni IPA n’est publié dans ce lot ; l’installation physique et les échanges entre appareils restent à vérifier.


## Lot : démarrer et corriger la configuration comptable

Le rapport natif indique désormais si les comptes de paie et de TVA différée sont requis. L’écran suit ces besoins (7, 8, 11 ou 12 comptes), y compris lorsqu’un ancien profil de TVA sur les encaissements existe. Il ne demande plus systématiquement le compte de TVA différée. Une réponse native ancienne conserve une vérification prudente et une explication visible. Les règles fiscales, les écritures et le schéma de données ne sont pas modifiés.

Le démarrage avec la base essentielle devient visible avant le plan complet. Une fenêtre présente les effets avant activation : 12 comptes de base, leurs liaisons et la reprise des opérations manquantes des périodes ouvertes. Elle distingue les périodes fermées qui nécessitent un contrôle des soldes d’ouverture. Le guide des délais commerciaux arrive dans cette même confirmation, sans empiler les fenêtres ni activer silencieusement la comptabilité.

Le réglage manuel est regroupé par ventes, achats, TVA et salaires. Les listes proposent les comptes actifs du type attendu. Un ancien choix incompatible reste identifiable ; la vérification ouvre et cible le champ à corriger. Les comptes qui doivent être distincts sont contrôlés avant envoi. La création d’un compte manquant ouvre le formulaire et conserve les choix de liaison déjà saisis.

La confirmation garde un résultat d’enregistrement acquitté. En cas d’échec des lectures ou des rapports, la reprise relit uniquement les comptes, l’espace de travail et les états : elle ne répète pas la configuration ou l’installation. Les doubles validations et la fermeture pendant le traitement sont bloquées ; la reprise des lectures reste accessible en lecture seule. Les compteurs du résultat sont présentés comme ceux de l’enregistrement, sans les confondre avec une résolution de tous les contrôles historiques.

Validation dans chaque dossier : 20 tests d’interface ciblés, 3 tests natifs, 16 parcours Edge/WebKit de configuration aux formats 320×568, 390×844, 844×390 et 1440×900 ; 4 parcours supplémentaires depuis le guide de configuration ; 8 parcours d’émission de facture vérifient le lien vers les comptes et la reprise de la facture. Les tests natifs couvrent les exigences hors paie/avec paie, le profil historique de TVA reçue, la préservation des réglages après refus et l’intégration d’une facture existante avant encaissement. Les recettes d’interface vérifient notamment le focus sur l’erreur, les types de compte proposés, la conservation des choix, le refus, le double clic, la lecture seule, les pannes de lecture et de rapport et la configuration retrouvée après rechargement. TypeScript et Vite compilent dans les deux dossiers. Les captures sur petit écran ont été inspectées.

Intégration dans le dossier principal par fusion à trois versions, avec sauvegarde dans `.qa/accounting-setup-before`. Deux conflits du fichier de recette ont été résolus en conservant l’import de l’assistant une seule fois et les commandes de lecture seule pour le chronomètre et la nouvelle configuration. Les autres travaux du dossier principal sont conservés.

Guide : [COMPTABILITE-DEMARRAGE.md](COMPTABILITE-DEMARRAGE.md). Données synthétiques uniquement ; aucun nouvel installateur ou IPA publié dans ce lot. Ces recettes ne remplacent ni le contrôle comptable de l’entreprise ni une vérification sur une installation physique.


## Lot : exercices guidés et confirmation de clôture lisible

L’écran Exercices explique les trois étapes : délimiter les dates, contrôler le dossier puis décider de la clôture. La création et la modification utilisent un formulaire contrôlé, avec propositions d’années civiles et dates personnalisables. Le nom personnalisé est conservé lors du choix d’une année. Les dates inclusives, leur ordre, les chevauchements et la limite de clôture cumulative sont expliqués au champ concerné. Le premier champ à corriger reçoit le focus ; le lendemain de la limite fermée peut être proposé explicitement lorsqu’il reste compatible avec la fin saisie.

Le même identifiant est conservé pendant les essais d’une création. Les doubles validations sont bloquées. Après un enregistrement acquitté, les erreurs de lecture se reprennent sans renvoyer la création ou la modification ; cette reprise fonctionne aussi en lecture seule. Le résultat propose de retrouver l’exercice ou d’ouvrir son dossier. Les filtres des rapports suivent les dates enregistrées, notamment après modification de l’exercice déjà sélectionné.

Le dossier sans exercice propose un accès direct à sa sélection ou sa création. Les contrôles de continuité et d’équilibre dirigent vers les comptes ou le journal, puis un bouton permet de revenir au dossier pour préparer une revue à jour. Les préparations de contrôle et confirmations de clôture respectent explicitement la lecture seule, conformément aux commandes natives existantes.

La confirmation finale est dans une fenêtre dédiée, avec les dates, l’effet du verrouillage et la saisie du nom exact. Elle explique que toutes les dates jusqu’à la fin sont verrouillées, y compris l’historique antérieur au début de l’exercice. L’ancienne formulation ne décrivait que l’intervalle de l’exercice alors que le moteur verrouille cumulativement. Un refus conserve la saisie et propose de refaire le contrôle depuis la fenêtre. La reprise d’actualisation après clôture et le partage du fichier déjà exporté restent disponibles.

Validation dans chaque dossier : 23 tests d’interface ciblés, 4 tests natifs, 8 parcours Edge/WebKit aux formats 320×568, 390×844, 844×390 et 1440×900, puis 7 parcours de clôture existants dans Edge. Les tests natifs vérifient l’identité et la date de création de l’exercice, les refus sans écriture de chevauchement/dates invalides, la frontière cumulative, le dossier ZIP définitif et la préservation des données/empreintes après refus d’écritures rétroactives. Les recettes de clôture couvrent aussi les contrôles périmés, les exports provisoires/définitifs, les erreurs de partage et l’isolation des réponses tardives. Le changement de période pendant la confirmation finale est bloqué dans l’interface ; le test de réponse tardive simule explicitement un changement externe pour conserver la couverture de cette protection.

TypeScript et Vite compilent dans les deux dossiers. Les captures sur petits écrans, notamment les erreurs de date et la fenêtre de clôture, ont été inspectées. Intégration par fusion à trois versions avec sauvegarde dans `.qa/period-guided-before`. Un conflit de recette a été résolu en conservant les commandes du chronomètre et en ajoutant celles des exercices/clôtures. Les travaux préexistants du dossier principal sont préservés.

Guide : [EXERCICES-ET-CLOTURE.md](EXERCICES-ET-CLOTURE.md). Aucune règle fiscale, logique de clôture native ou migration n’est modifiée. Données de recette uniquement ; aucun nouvel installateur ni IPA publié dans ce lot.


## Lot : recherche dans les textes et réutilisation des présentations

L’atelier des factures, devis, bilans et fiches de salaire permet de rechercher une phrase dans la zone de texte affichée, de parcourir les résultats et de remplacer un passage ou tous les résultats en une action annulable. La recherche traite les caractères saisis comme du texte, conserve les positions des caractères Unicode et propose le respect des majuscules/minuscules. Ctrl+F ou Cmd+F reprend aussi le passage sélectionné lorsque la recherche est déjà ouverte. Échap la ferme.

Les remplacements conservent le style du premier caractère trouvé, les paragraphes, les listes et la mise en forme des textes voisins. Les occurrences ajoutées ne sont pas remplacées en boucle. Les limites de texte, notamment du pied de page, refusent l’opération entière sans perte ; une expansion trop grande est rejetée avant sa construction. Les remplacements sont désactivés pendant l’enregistrement.

La copie de présentation conserve maintenant par défaut les textes de la catégorie cible. La case « Copier aussi les textes » rend explicite le remplacement de l’introduction, des conditions/commentaires et du pied de page, y compris sa version simple. Le retour au style de départ conserve aussi les textes, avec une option explicite pour les effacer. Ces opérations restent annulables.

L’historique de l’atelier mémorise uniquement les catégories de documents modifiées. L’annulation préserve les réglages de l’entreprise et les autres catégories actualisés entre-temps. Si la catégorie concernée a changé ailleurs, son état actuel est conservé et l’ancien historique est écarté avec une explication. L’historique interne du texte est remis à zéro après une modification externe pour éviter de réintroduire un ancien texte par « Rétablir ».

Validation dans chaque dossier : 35 tests unitaires ciblés, 8 tests natifs de composition et d’exemples PDF, 8 parcours Edge/WebKit aux formats 320×568, 390×844, 844×390 et 1440×1000. Chaque parcours vérifie les quatre catégories, les sélections, les remplacements, l’annulation, la lecture pendant le verrouillage, les limites du pied de page, la copie et la réinitialisation, une actualisation du nom de l’entreprise, la sauvegarde/rechargement et les données envoyées à l’export. Les anciens parcours de collage Word/Docs passent aussi dans Edge et WebKit sur la base de livraison (6 parcours), ainsi que ceux de composition, typographie et couleurs (9 parcours Edge) et les 8 contrôles de l’atelier initial.

TypeScript et Vite compilent dans les deux dossiers. Les captures des petits écrans ont été inspectées. Les tests de navigateur utilisent des données synthétiques, des PDF de recette et un stockage de test ; ils ne prouvent pas une installation physique. Les tests natifs vérifient notamment les polices/couleurs, les logos, la pagination et la préservation des valeurs comptables. Aucun moteur PDF, calcul financier ou schéma de données n’a changé.

Intégration dans le dossier principal par fusion à trois versions sans conflit ; sauvegarde dans `.qa/document-tools-before`. Les autres travaux du dossier principal sont conservés. Guide : [PERSONNALISATION-DOCUMENTS.md](PERSONNALISATION-DOCUMENTS.md). Aucun nouvel installateur ou IPA n’est publié dans ce lot.
